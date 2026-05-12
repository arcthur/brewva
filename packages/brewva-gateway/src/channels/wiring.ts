import { BrewvaRuntime, createTrustedLocalGovernancePort } from "@brewva/brewva-runtime";
import { createRecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { createHostedSession } from "../hosted/api.js";
import { resolveBrewvaUpdateExecutionScope } from "../ingress/api.js";
import { toErrorMessage } from "../utils/errors.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import { createInstrumentedChannelA2AAdapter } from "./bridges/a2a/adapter.js";
import { createChannelA2AExtension } from "./bridges/a2a/extension.js";
import { collectPromptTurnOutputs, createChannelAgentDispatch } from "./channel-agent-dispatch.js";
import { runChannelHostLifecycle } from "./channel-host-lifecycle.js";
import { createChannelReplyWriter } from "./channel-reply-writer.js";
import {
  createChannelTurnDispatcher,
  type ChannelTurnDispatcher,
} from "./channel-turn-dispatcher.js";
import { CommandRouter } from "./command/parser.js";
import { createChannelControlRouter } from "./command/router.js";
import { ChannelCoordinator } from "./coordinator.js";
import { DEFAULT_CHANNEL_LAUNCHERS } from "./default-launchers.js";
import {
  formatSupportedChannels,
  resolveSupportedChannel,
  type ChannelModeLaunchBundle,
  type ChannelModeLauncher,
  type ChannelModeLauncherInput,
  type SupportedChannel,
} from "./launcher.js";
import { resolveChannelOrchestrationConfig } from "./orchestration-config.js";
import { resolveTelegramChannelPolicyState } from "./policy/channel-policy.js";
import type { RunChannelModeDependencies } from "./ports.js";
import { createChannelSessionCoordinator } from "./session/coordinator.js";
import { createChannelSessionQueries } from "./session/queries.js";
import { createChannelUpdateLockManager } from "./session/update-lock.js";
import type { RunChannelModeOptions } from "./types.js";

const CHANNEL_SESSION_CLEANUP_GRACEFUL_TIMEOUT_MS = 2_000;

export async function runChannelModeOperation(options: RunChannelModeOptions): Promise<void> {
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

  const telegramChannelPolicyState = resolveTelegramChannelPolicyState();
  const dependencies: RunChannelModeDependencies | undefined = options.dependencies;
  const createSession = dependencies?.createSession ?? createHostedSession;
  const collectPromptOutputs = dependencies?.collectPromptTurnOutputs ?? collectPromptTurnOutputs;
  const channelLaunchers: Record<SupportedChannel, ChannelModeLauncher> = {
    ...DEFAULT_CHANNEL_LAUNCHERS,
    ...dependencies?.launchers,
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
    routingScopes: orchestrationConfig.enabled ? ["core", "domain", "operator", "meta"] : undefined,
    routingDefaultScopes: orchestrationConfig.enabled
      ? ["core", "domain", "operator", "meta"]
      : undefined,
  });
  const commandRouter = new CommandRouter();

  const recoveryWalStore = createRecoveryWalStore({
    workspaceRoot: runtime.workspaceRoot,
    config: runtime.config.infrastructure.recoveryWal,
    scope: `channel-${channel}`,
    recordEvent: (input) => {
      runtime.extensions.hosted.events.record({
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        skipTapeCheckpoint: true,
      });
    },
  });
  const recoveryWalScope = recoveryWalStore.getScope();
  const recoveryWalCompactIntervalMs = Math.max(
    30_000,
    Math.floor(runtime.config.infrastructure.recoveryWal.compactAfterMs / 2),
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
    createExtensions: () => [
      createChannelA2AExtension({
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
    recoveryWalScope,
    cleanupGracefulTimeoutMs: CHANNEL_SESSION_CLEANUP_GRACEFUL_TIMEOUT_MS,
  });
  const sessionQueries = createChannelSessionQueries({
    runtime,
    registry,
    runtimeManager,
    recoveryWalScope,
    listLiveSessions: () => sessionCoordinator.listLiveSessions(),
    openLiveSession: (scopeKey, agentId) => sessionCoordinator.openLiveSession(scopeKey, agentId),
    loadInspectionRuntime: (agentId) => sessionCoordinator.loadInspectionRuntime(agentId),
    getSessionCostSummary: (sessionId) => sessionCoordinator.getSessionCostSummary(sessionId),
    hasReplayableEffectCommitmentRequest: (sessionId, requestId) =>
      sessionCoordinator.hasReplayableEffectCommitmentRequest(sessionId, requestId),
  });

  const updateLock = createChannelUpdateLockManager({
    updateExecutionScope,
  });

  const { executePromptForAgent, processUserTurnOnAgent } = createChannelAgentDispatch({
    registry,
    sessionCoordinator,
    replyWriter,
    collectPromptTurnOutputs: collectPromptOutputs,
    channelPolicyState: telegramChannelPolicyState,
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
      const turn =
        (input.fromSessionId
          ? sessionCoordinator.getRepresentativeTurnByAgentSessionId(input.fromSessionId)
          : undefined) ?? (scopeKey ? dispatcher.getLastTurn(scopeKey) : undefined);
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
    dependencies,
  });

  dispatcher = createChannelTurnDispatcher({
    runtime,
    recoveryWalStore,
    orchestrationEnabled: orchestrationConfig.enabled,
    defaultAgentId: runtime.agentId,
    commandRouter,
    replyWriter,
    resolveScopeKey: (turn) => sessionCoordinator.resolveScopeKey(turn),
    resolveFocusedAgentId: (scopeKey) => registry.resolveFocus(scopeKey),
    resolveApprovalTargetAgentIdDurably: (scopeKey, requestId) =>
      sessionQueries.resolveApprovalTargetAgentIdDurably(scopeKey, requestId),
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
              const ingressHighWatermark = recoveryWalStore.getIngressHighWatermark({
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
      recoveryWalStore,
      recoveryWalCompactIntervalMs,
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
