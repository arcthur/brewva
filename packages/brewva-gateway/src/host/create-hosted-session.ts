import { join, resolve } from "node:path";
import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  recordAssistantUsageFromMessage,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
} from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  resolveBrewvaModelSelection,
  type BrewvaToolOrchestration,
} from "@brewva/brewva-tools";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  editTool,
  ModelRegistry,
  readTool,
  SettingsManager,
  writeTool,
  type AgentSessionEvent,
  type CreateAgentSessionResult,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import {
  createBrewvaExtension,
  createRuntimeCoreBridgeExtension,
} from "../runtime-plugins/index.js";
import {
  createDetachedSubagentBackgroundController,
  createHostedSubagentAdapter,
  type HostedSubagentBuiltinToolName,
} from "../subagents/index.js";

export interface HostedSessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

export interface CreateHostedSessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
  extensionFactories?: ExtensionFactory[];
  orchestration?: BrewvaToolOrchestration;
  managedToolNames?: readonly string[];
  builtinToolNames?: readonly HostedSubagentBuiltinToolName[];
  enableSubagents?: boolean;
  scopeId?: string;
}

function resolveBuiltinTools(
  builtinToolNames: readonly HostedSubagentBuiltinToolName[] | undefined,
): Array<typeof readTool | typeof editTool | typeof writeTool> {
  const requested = new Set(builtinToolNames ?? ["read", "edit", "write"]);
  const tools: Array<typeof readTool | typeof editTool | typeof writeTool> = [];
  if (requested.has("read")) {
    tools.push(readTool);
  }
  if (requested.has("edit")) {
    tools.push(editTool);
  }
  if (requested.has("write")) {
    tools.push(writeTool);
  }
  return tools;
}

function sameRoutingScopes(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((scope, index) => scope === expected[index]);
}

function applyRuntimeUiSettings(
  settingsManager: SettingsManager,
  uiConfig: BrewvaRuntime["config"]["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
  });
}

export function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: HostedSessionResult["session"],
): () => void {
  let turnIndex = 0;

  return session.subscribe((event: AgentSessionEvent) => {
    const sessionId = session.sessionManager.getSessionId();

    switch (event.type) {
      case "agent_start":
        turnIndex = 0;
        runtime.events.record({
          sessionId,
          type: "agent_start",
        });
        break;
      case "turn_start":
        runtime.context.onTurnStart(sessionId, turnIndex);
        runtime.events.record({
          sessionId,
          type: "turn_start",
          turn: turnIndex,
        });
        break;
      case "turn_end": {
        const toolResults = Array.isArray((event as { toolResults?: unknown }).toolResults)
          ? (event as { toolResults: unknown[] }).toolResults.length
          : 0;
        runtime.context.onTurnEnd(sessionId);
        runtime.events.record({
          sessionId,
          type: "turn_end",
          turn: turnIndex,
          payload: { toolResults },
        });
        turnIndex += 1;
        break;
      }
      case "message_end":
        recordAssistantUsageFromMessage(
          runtime,
          sessionId,
          (event as { message?: unknown }).message,
        );
        break;
      case "tool_execution_start":
        runtime.events.record({
          sessionId,
          type: "tool_execution_start",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_update":
        runtime.events.record({
          sessionId,
          type: "tool_execution_update",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
          },
        });
        break;
      case "tool_execution_end":
        runtime.events.record({
          sessionId,
          type: "tool_execution_end",
          payload: {
            toolCallId: (event as { toolCallId?: unknown }).toolCallId,
            toolName: (event as { toolName?: unknown }).toolName,
            isError: (event as { isError?: unknown }).isError === true,
          },
        });
        break;
      case "agent_end":
        runtime.events.record({
          sessionId,
          type: "agent_end",
          payload: {
            messageCount: Array.isArray((event as { messages?: unknown }).messages)
              ? (event as { messages: unknown[] }).messages.length
              : 0,
            costSummary: runtime.cost.getSummary(sessionId),
          },
        });
        break;
      default:
        break;
    }
  });
}

export async function createHostedSession(
  options: CreateHostedSessionOptions = {},
): Promise<HostedSessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveBrewvaModelSelection(options.model, modelRegistry);

  const runtime =
    options.runtime ??
    new BrewvaRuntime({
      cwd,
      configPath: options.configPath,
      config: undefined,
      agentId: options.agentId,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
      routingScopes: options.routingScopes,
    });

  const hasRoutingOverride = Boolean(options.routingScopes && options.routingScopes.length > 0);
  const requestedRoutingScopes = options.routingScopes ? [...new Set(options.routingScopes)] : [];
  if (options.runtime && hasRoutingOverride) {
    const runtimeRoutingEnabled = runtime.config.skills.routing.enabled;
    const runtimeRoutingScopes = [...runtime.config.skills.routing.scopes];
    if (
      !runtimeRoutingEnabled ||
      !sameRoutingScopes(runtimeRoutingScopes, requestedRoutingScopes)
    ) {
      throw new Error(
        "routingScopes must be applied when constructing BrewvaRuntime; createHostedSession no longer mutates runtime.config",
      );
    }
  }
  const skillLoadReport = runtime.skills.getLoadReport();
  const autoSubagentsEnabled = options.enableSubagents !== false;
  const orchestration: BrewvaToolOrchestration | undefined = (() => {
    if (!autoSubagentsEnabled || options.orchestration?.subagents) {
      return options.orchestration;
    }
    const subagents = createHostedSubagentAdapter({
      runtime,
      backgroundController: createDetachedSubagentBackgroundController({
        runtime,
        configPath: options.configPath,
        routingScopes: options.routingScopes,
      }),
      createChildSession: (childOptions) =>
        createHostedSession({
          cwd: childOptions.cwd ?? cwd,
          configPath: childOptions.configPath ?? options.configPath,
          model: childOptions.model,
          agentId: childOptions.agentId,
          enableExtensions: childOptions.enableExtensions,
          enableSubagents: childOptions.enableSubagents,
          orchestration: childOptions.orchestration,
          managedToolNames: childOptions.managedToolNames,
          builtinToolNames: childOptions.builtinToolNames,
          routingScopes: options.routingScopes,
          scopeId: options.scopeId,
        }),
    });
    return {
      ...options.orchestration,
      subagents,
    };
  })();

  const settingsManager = SettingsManager.create(cwd, agentDir);
  applyRuntimeUiSettings(settingsManager, runtime.config.ui);

  const extensionsEnabled = options.enableExtensions !== false;
  const extensionFactories = extensionsEnabled
    ? [
        createBrewvaExtension({
          runtime,
          registerTools: true,
          orchestration,
          managedToolNames: options.managedToolNames,
        }),
      ]
    : [createRuntimeCoreBridgeExtension({ runtime })];
  if (options.extensionFactories && options.extensionFactories.length > 0) {
    extensionFactories.push(...options.extensionFactories);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories,
  });
  await resourceLoader.reload();

  const customTools = extensionsEnabled
    ? undefined
    : buildBrewvaTools({
        runtime,
        orchestration,
        toolNames: options.managedToolNames,
      });
  const builtinTools = resolveBuiltinTools(options.builtinToolNames);

  const sessionResult = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    model: selectedModel.model,
    thinkingLevel: selectedModel.thinkingLevel,
    tools: builtinTools,
    customTools,
  });

  const sessionId = sessionResult.session.sessionManager.getSessionId();
  if (!extensionsEnabled) {
    runtime.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd },
    });
    registerRuntimeCoreEventBridge(runtime, sessionResult.session);
  }

  runtime.events.record({
    sessionId,
    type: "session_bootstrap",
    payload: {
      cwd,
      agentId: runtime.agentId,
      extensionsEnabled,
      skillLoad: {
        routingEnabled: skillLoadReport.routingEnabled,
        routingScopes: skillLoadReport.routingScopes,
        routableSkills: skillLoadReport.routableSkills,
        hiddenSkills: skillLoadReport.hiddenSkills,
        overlaySkills: skillLoadReport.overlaySkills,
      },
    },
  });

  return {
    ...sessionResult,
    runtime,
  };
}
