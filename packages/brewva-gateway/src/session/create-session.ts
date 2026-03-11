import { join, resolve } from "node:path";
import { createBrewvaExtension, createRuntimeCoreBridgeExtension } from "@brewva/brewva-extensions";
import {
  BrewvaRuntime,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
  recordAssistantUsageFromMessage,
} from "@brewva/brewva-runtime";
import { createSkillBrokerExtension } from "@brewva/brewva-skill-broker";
import { buildBrewvaTools, resolveBrewvaModelSelection } from "@brewva/brewva-tools";
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
} from "@mariozechner/pi-coding-agent";

export interface GatewaySessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

export interface CreateGatewaySessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
}

function applyRuntimeUiSettings(
  settingsManager: SettingsManager,
  uiConfig: BrewvaRuntime["config"]["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
  });
}

function registerRuntimeCoreEventBridge(
  runtime: BrewvaRuntime,
  session: GatewaySessionResult["session"],
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
      case "agent_end":
        runtime.events.record({
          sessionId,
          type: "agent_end",
        });
        break;
      default:
        break;
    }
  });
}

export async function createGatewaySession(
  options: CreateGatewaySessionOptions = {},
): Promise<GatewaySessionResult> {
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
    });

  if (options.routingProfile) {
    runtime.config.skills.routing.profile = options.routingProfile;
  }
  if (options.routingScopes && options.routingScopes.length > 0) {
    runtime.config.skills.routing.scopes = [...new Set(options.routingScopes)];
  }
  if (options.routingProfile || (options.routingScopes && options.routingScopes.length > 0)) {
    runtime.skills.refresh();
  }
  const skillLoadReport = runtime.skills.getLoadReport();

  const settingsManager = SettingsManager.create(cwd, agentDir);
  applyRuntimeUiSettings(settingsManager, runtime.config.ui);

  const extensionsEnabled = options.enableExtensions !== false;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createSkillBrokerExtension({ runtime }),
      ...(extensionsEnabled
        ? [createBrewvaExtension({ runtime, registerTools: true })]
        : [createRuntimeCoreBridgeExtension({ runtime })]),
    ],
  });
  await resourceLoader.reload();

  const customTools = extensionsEnabled ? undefined : buildBrewvaTools({ runtime });

  const sessionResult = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    resourceLoader,
    model: selectedModel.model,
    thinkingLevel: selectedModel.thinkingLevel,
    tools: [readTool, editTool, writeTool],
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
      skillBroker: {
        enabled: true,
        proposalBoundary: "runtime.proposals.submit",
      },
      skillLoad: {
        routingProfile: skillLoadReport.routingProfile,
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
