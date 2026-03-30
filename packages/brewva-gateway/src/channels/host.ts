import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  type ManagedToolMode,
} from "@brewva/brewva-runtime";
import { TurnWALStore } from "@brewva/brewva-runtime/channels";
import { createHostedSession, type HostedSessionResult } from "../host/create-hosted-session.js";
import { resolveBrewvaUpdateExecutionScope } from "../update-workflow.js";
import { toErrorMessage } from "../utils/errors.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { createInstrumentedChannelA2AAdapter } from "./channel-a2a-adapter.js";
import { createChannelA2ARuntimePlugin } from "./channel-a2a-runtime-plugin.js";
import {
  collectPromptTurnOutputs,
  createChannelAgentDispatch,
  type PromptTurnOutputSession,
  type PromptTurnOutputs,
} from "./channel-agent-dispatch.js";
import {
  DEFAULT_CHANNEL_LAUNCHERS,
  formatSupportedChannels,
  type ChannelModeConfig,
  type ChannelModeLaunchBundle,
  type ChannelModeLauncher,
  type ChannelModeLauncherInput,
  resolveSupportedChannel,
  type SupportedChannel,
} from "./channel-bootstrap.js";
import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./channel-command-contracts.js";
import { createChannelControlRouter } from "./channel-control-router.js";
import { runChannelHostLifecycle } from "./channel-host-lifecycle.js";
import { createChannelReplyWriter } from "./channel-reply-writer.js";
import { createChannelSessionCoordinator } from "./channel-session-coordinator.js";
import { createChannelSessionQueries } from "./channel-session-queries.js";
import {
  createChannelTurnDispatcher,
  type ChannelTurnDispatcher,
} from "./channel-turn-dispatcher.js";
import { createChannelUpdateLockManager } from "./channel-update-lock.js";
import { CommandRouter } from "./command-router.js";
import { ChannelCoordinator } from "./coordinator.js";
import { resolveChannelOrchestrationConfig } from "./orchestration-config.js";
import { resolveTelegramChannelSkillPolicyState } from "./skill-policy.js";

export interface RunChannelModeOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  managedToolMode: ManagedToolMode;
  verbose: boolean;
  channel: string;
  channelConfig?: ChannelModeConfig;
  onRuntimeReady?: (runtime: BrewvaRuntime) => void;
  shutdownSignal?: AbortSignal;
  dependencies?: RunChannelModeDependencies;
}

export interface RunChannelModeDependencies {
  createSession?: (
    options?: Parameters<typeof createHostedSession>[0],
  ) => Promise<HostedSessionResult>;
  collectPromptTurnOutputs?: (
    session: PromptTurnOutputSession,
    prompt: string,
    options?: {
      runtime?: BrewvaRuntime;
      sessionId?: string;
      turnId?: string;
    },
  ) => Promise<PromptTurnOutputs>;
  handleInspectCommand?: (
    input: ChannelInspectCommandInput,
  ) => Promise<ChannelInspectCommandResult>;
  handleInsightsCommand?: (
    input: ChannelInsightsCommandInput,
  ) => Promise<ChannelInsightsCommandResult>;
  handleQuestionsCommand?: (
    input: ChannelQuestionsCommandInput,
  ) => Promise<ChannelQuestionsCommandResult>;
  launchers?: Partial<Record<SupportedChannel, ChannelModeLauncher>>;
}
const CHANNEL_SESSION_CLEANUP_GRACEFUL_TIMEOUT_MS = 2_000;

export async function runChannelMode(options: RunChannelModeOptions): Promise<void> {
  const channel = resolveSupportedChannel(options.channel);
  if (!channel) {
    console.error(
      `Error: unsupported channel "${options.channel}". Supported channels: ${formatSupportedChannels()}.`,
    );
    process.exitCode = 1;
    return;
  }

  const runtime = new BrewvaRuntime({
    cwd: options.cwd,
    configPath: options.configPath,
    agentId: options.agentId,
    governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
  });
  options.onRuntimeReady?.(runtime);

  const telegramSkillPolicyState = resolveTelegramChannelSkillPolicyState({
    availableSkillNames: runtime.skills.list().map((skill) => skill.name),
  });
  if (channel === "telegram" && telegramSkillPolicyState.missingSkillNames.length > 0) {
    runtime.events.record({
      sessionId: "channel:system",
      type: "channel_skill_policy_degraded",
      payload: {
        channel: "telegram",
        missingSkillNames: telegramSkillPolicyState.missingSkillNames,
      },
      skipTapeCheckpoint: true,
    });
    if (options.verbose) {
      console.error(
        `[channel:telegram] skill policy degraded: missing skills ${telegramSkillPolicyState.missingSkillNames.join(", ")}`,
      );
    }
  }

  const createSession = options.dependencies?.createSession ?? createHostedSession;
  const collectPromptOutputs =
    options.dependencies?.collectPromptTurnOutputs ?? collectPromptTurnOutputs;
  const channelLaunchers: Record<SupportedChannel, ChannelModeLauncher> = {
    ...DEFAULT_CHANNEL_LAUNCHERS,
    ...options.dependencies?.launchers,
  };

  const orchestrationConfig = resolveChannelOrchestrationConfig(runtime);
  const scopeStrategy = orchestrationConfig.enabled ? orchestrationConfig.scopeStrategy : "chat";

  const registry = await AgentRegistry.create({
    workspaceRoot: runtime.workspaceRoot,
  });
  const runtimeManager = new AgentRuntimeManager({
    controllerRuntime: runtime,
    maxLiveRuntimes: orchestrationConfig.limits.maxLiveRuntimes,
    idleRuntimeTtlMs: orchestrationConfig.limits.idleRuntimeTtlMs,
  });
  const commandRouter = new CommandRouter();

  const turnWalStore = new TurnWALStore({
    workspaceRoot: runtime.workspaceRoot,
    config: runtime.config.infrastructure.turnWal,
    scope: `channel-${channel}`,
    recordEvent: (input) => {
      runtime.events.record({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
  });
  const turnWalCompactIntervalMs = Math.max(
    30_000,
    Math.floor(runtime.config.infrastructure.turnWal.compactAfterMs / 2),
  );
  const updateExecutionScope = resolveBrewvaUpdateExecutionScope(runtime);
  let shuttingDown = false;

  let bundle: ChannelModeLaunchBundle;
  let coordinator: ChannelCoordinator;
  let dispatcher: ChannelTurnDispatcher;

  const replyWriter = createChannelReplyWriter({
    runtime,
    sendTurn: async (turn) => bundle.bridge.sendTurn(turn),
  });

  const a2aAdapter = createInstrumentedChannelA2AAdapter({
    runtime,
    coordinator: {
      a2aSend: (input) => coordinator.a2aSend(input),
      a2aBroadcast: (input) => coordinator.a2aBroadcast(input),
      listAgents: (input) => coordinator.listAgents(input),
    },
  });

  const sessionCoordinator = createChannelSessionCoordinator({
    runtime,
    registry,
    runtimeManager,
    createSession,
    createRuntimePlugins: () => [
      createChannelA2ARuntimePlugin({
        adapter: a2aAdapter,
      }),
    ],
    sessionOptions: {
      cwd: options.cwd,
      configPath: options.configPath,
      model: options.model,
      managedToolMode: options.managedToolMode,
    },
    scopeStrategy,
    idleRuntimeTtlMs: orchestrationConfig.limits.idleRuntimeTtlMs,
    turnWalScope: turnWalStore.scope,
    cleanupGracefulTimeoutMs: CHANNEL_SESSION_CLEANUP_GRACEFUL_TIMEOUT_MS,
  });
  const sessionQueries = createChannelSessionQueries({
    runtime,
    registry,
    runtimeManager,
    turnWalScope: turnWalStore.scope,
    listLiveSessions: () => sessionCoordinator.listLiveSessions(),
    openLiveSession: (scopeKey, agentId) => sessionCoordinator.openLiveSession(scopeKey, agentId),
    loadInspectionRuntime: (agentId) => sessionCoordinator.loadInspectionRuntime(agentId),
    getSessionCostSummary: (sessionId) => sessionCoordinator.getSessionCostSummary(sessionId),
    hasPendingEffectCommitment: (sessionId, requestId) =>
      sessionCoordinator.hasPendingEffectCommitment(sessionId, requestId),
  });

  const updateLock = createChannelUpdateLockManager({
    updateExecutionScope,
  });

  const { executePromptForAgent, processUserTurnOnAgent } = createChannelAgentDispatch({
    registry,
    sessionCoordinator,
    replyWriter,
    collectPromptTurnOutputs: collectPromptOutputs,
    skillPolicyState: telegramSkillPolicyState,
  });

  coordinator = new ChannelCoordinator({
    limits: {
      fanoutMaxAgents: orchestrationConfig.limits.fanoutMaxAgents,
      maxDiscussionRounds: orchestrationConfig.limits.maxDiscussionRounds,
      a2aMaxDepth: orchestrationConfig.limits.a2aMaxDepth,
      a2aMaxHops: orchestrationConfig.limits.a2aMaxHops,
    },
    dispatch: async (input) => {
      const sourceState = input.fromSessionId
        ? sessionCoordinator.getSessionByAgentSessionId(input.fromSessionId)
        : undefined;
      const scopeKey = input.scopeKey ?? sourceState?.scopeKey;
      const turn = scopeKey ? dispatcher.getLastTurn(scopeKey) : undefined;
      if (!scopeKey || !turn) {
        return {
          ok: false,
          agentId: input.agentId,
          responseText: "",
          error: "dispatch_scope_unavailable",
        };
      }
      return executePromptForAgent({
        scopeKey,
        agentId: input.agentId,
        prompt: input.task,
        reason: input.reason,
        turn,
        correlationId: input.correlationId,
        fromAgentId: input.fromAgentId,
        fromSessionId: input.fromSessionId,
        depth: input.depth,
        hops: input.hops,
      });
    },
    isAgentActive: (agentId) => registry.isActive(agentId),
    listAgents: ({ includeDeleted } = {}) =>
      registry.list({ includeDeleted }).map((entry) => ({
        agentId: entry.agentId,
        status: entry.status,
      })),
    resolveAgentBySessionId: (sessionId) =>
      sessionCoordinator.getSessionByAgentSessionId(sessionId)?.agentId,
    forbidSelfA2A: true,
  });

  const controlRouter = createChannelControlRouter({
    runtime,
    registry,
    orchestrationConfig,
    replyWriter,
    coordinator,
    renderAgentsSnapshot: (scopeKey) => sessionQueries.renderAgentsSnapshot(scopeKey),
    openLiveSession: (scopeKey, agentId) => sessionCoordinator.openLiveSession(scopeKey, agentId),
    resolveQuestionSurface: (scopeKey, agentId) =>
      sessionQueries.resolveQuestionSurface(scopeKey, agentId),
    cleanupAgentSessions: (agentId) => sessionCoordinator.cleanupAgentSessions(agentId),
    disposeAgentRuntime: (agentId) => sessionCoordinator.disposeRuntime(agentId),
    updateLock,
    updateExecutionScope,
    dependencies: options.dependencies,
  });

  dispatcher = createChannelTurnDispatcher({
    runtime,
    turnWalStore,
    orchestrationEnabled: orchestrationConfig.enabled,
    defaultAgentId: runtime.agentId,
    commandRouter,
    replyWriter,
    resolveScopeKey: (turn) => sessionCoordinator.resolveScopeKey(turn),
    resolveFocusedAgentId: (scopeKey) => registry.resolveFocus(scopeKey),
    isAgentActive: (agentId) => registry.isActive(agentId),
    resolveLiveSessionId: (scopeKey, agentId) =>
      sessionCoordinator.getLiveSession(scopeKey, agentId)?.agentSessionId,
    resolveApprovalTargetAgentId: (scopeKey, requestId) =>
      sessionQueries.resolveApprovalTargetAgentId(scopeKey, requestId),
    processUserTurnOnAgent,
    handleCommand: (match, turn, scopeKey, preparedCommand) =>
      controlRouter.handleCommand(match, turn, scopeKey, preparedCommand),
    prepareCommand: (match, turn, scopeKey) => controlRouter.prepareCommand(match, turn, scopeKey),
    isShuttingDown: () => shuttingDown,
  });

  try {
    const recovery =
      channel === "telegram"
        ? {
            initialPollingOffset: (() => {
              const ingressHighWatermark = turnWalStore.getIngressHighWatermark({
                source: "channel",
                channel: "telegram",
              });
              return ingressHighWatermark === undefined ? undefined : ingressHighWatermark + 1;
            })(),
          }
        : undefined;
    const launcherInput: ChannelModeLauncherInput & {
      recovery?: {
        initialPollingOffset?: number;
      };
    } = {
      runtime,
      channelConfig: options.channelConfig,
      recovery,
      resolveIngestedSessionId: (turn) => dispatcher.resolveIngestedSessionId(turn),
      onInboundTurn: async (turn) => {
        await dispatcher.enqueueInboundTurn(turn);
      },
      onAdapterError: async (error) => {
        if (options.verbose) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[channel:${channel}:error] ${message}`);
        }
      },
    };
    bundle = channelLaunchers[channel](launcherInput);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  try {
    await runChannelHostLifecycle({
      runtime,
      channel,
      verbose: options.verbose,
      bundle,
      turnWalStore,
      turnWalCompactIntervalMs,
      dispatcher,
      sessionCoordinator,
      runtimeManager,
      shutdownSignal: options.shutdownSignal,
      setShuttingDown: (next) => {
        shuttingDown = next;
      },
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
