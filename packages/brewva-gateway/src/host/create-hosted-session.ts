import { join, resolve } from "node:path";
import {
  createDeliberationMemoryContextProvider,
  createOptimizationContinuityContextProvider,
} from "@brewva/brewva-deliberation";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  createTrustedLocalGovernancePort,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
  type ManagedToolMode,
} from "@brewva/brewva-runtime";
import { createSkillPromotionContextProvider } from "@brewva/brewva-skill-broker";
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
  type CreateAgentSessionResult,
  type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { createHostedTurnPipeline } from "../runtime-plugins/index.js";
import {
  installHostedProviderCompatibilityLayer,
  registerHostedSessionProviderCompatibility,
} from "../runtime-plugins/provider-compatibility.js";
import { installSessionCompactionRecovery } from "../session/compaction-recovery.js";
import {
  createDetachedSubagentBackgroundController,
  createHostedSubagentAdapter,
  type HostedDelegationBuiltinToolName,
} from "../subagents/index.js";

export interface HostedSessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

export interface CreateHostedSessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
  extensionFactories?: ExtensionFactory[];
  orchestration?: BrewvaToolOrchestration;
  managedToolNames?: readonly string[];
  builtinToolNames?: readonly HostedDelegationBuiltinToolName[];
  enableSubagents?: boolean;
  scopeId?: string;
}

function resolveBuiltinTools(
  builtinToolNames: readonly HostedDelegationBuiltinToolName[] | undefined,
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

function resolveManagedToolMode(mode: ManagedToolMode | undefined): ManagedToolMode {
  return mode === "direct" ? "direct" : "extension";
}

export async function createHostedSession(
  options: CreateHostedSessionOptions = {},
): Promise<HostedSessionResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();
  installHostedProviderCompatibilityLayer();

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveBrewvaModelSelection(options.model, modelRegistry);

  const runtime =
    options.runtime ??
    new BrewvaRuntime({
      cwd,
      configPath: options.configPath,
      config: options.config,
      agentId: options.agentId,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
      routingScopes: options.routingScopes,
    });

  if (
    !runtime.context
      .listProviders()
      .some((provider) => provider.source === CONTEXT_SOURCES.deliberationMemory)
  ) {
    runtime.context.registerProvider(
      createDeliberationMemoryContextProvider({
        runtime,
      }),
    );
  }
  if (
    !runtime.context
      .listProviders()
      .some((provider) => provider.source === CONTEXT_SOURCES.optimizationContinuity)
  ) {
    runtime.context.registerProvider(
      createOptimizationContinuityContextProvider({
        runtime,
      }),
    );
  }
  if (
    !runtime.context
      .listProviders()
      .some((provider) => provider.source === CONTEXT_SOURCES.skillPromotionDrafts)
  ) {
    runtime.context.registerProvider(
      createSkillPromotionContextProvider({
        runtime,
      }),
    );
  }

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
          config: childOptions.config,
          model: childOptions.model,
          agentId: childOptions.agentId,
          managedToolMode: childOptions.managedToolMode,
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

  const managedToolMode = resolveManagedToolMode(options.managedToolMode);
  const registerManagedTools = managedToolMode === "extension";
  const extensionFactories = [
    createHostedTurnPipeline({
      runtime,
      registerTools: registerManagedTools,
      orchestration,
      managedToolNames: options.managedToolNames,
    }),
  ];
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

  const customTools =
    managedToolMode === "direct"
      ? buildBrewvaTools({
          runtime,
          orchestration,
          toolNames: options.managedToolNames,
        })
      : undefined;
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

  const session = installSessionCompactionRecovery(sessionResult.session, { runtime });

  const sessionId = session.sessionManager.getSessionId();
  registerHostedSessionProviderCompatibility({
    sessionId,
    runtime,
  });
  runtime.events.record({
    sessionId,
    type: "session_bootstrap",
    payload: {
      cwd,
      agentId: runtime.agentId,
      managedToolMode,
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
    session,
    runtime,
  };
}
