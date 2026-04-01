import { join, resolve } from "node:path";
import {
  createNarrativeMemoryContextProvider,
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
  type BrewvaSemanticOracle,
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
} from "@mariozechner/pi-coding-agent";
import { createHostedTurnPipeline, type RuntimePlugin } from "../runtime-plugins/index.js";
import { installSessionCompactionRecovery } from "../session/compaction-recovery.js";
import {
  createDetachedSubagentBackgroundController,
  createDelegationModelRoutingContext,
  HostedDelegationStore,
  createHostedSubagentAdapter,
  type HostedDelegationBuiltinToolName,
} from "../subagents/index.js";
import { createHostedSemanticOracle } from "./semantic-oracle.js";

export interface HostedSessionResult extends CreateAgentSessionResult {
  runtime: BrewvaRuntime;
}

export interface CreateHostedSessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime;
  runtimePlugins?: RuntimePlugin[];
  orchestration?: BrewvaToolOrchestration;
  managedToolNames?: readonly string[];
  builtinToolNames?: readonly HostedDelegationBuiltinToolName[];
  contextProfile?: "minimal" | "standard" | "full";
  enableSubagents?: boolean;
  scopeId?: string;
}

interface HostedEnvironment {
  cwd: string;
  agentDir: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  selectedModel: ReturnType<typeof resolveBrewvaModelSelection>;
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
  return mode === "direct" ? "direct" : "runtime_plugin";
}

function resolveHostedEnvironment(options: CreateHostedSessionOptions): HostedEnvironment {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  const selectedModel = resolveBrewvaModelSelection(options.model, modelRegistry);

  return {
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    selectedModel,
  };
}

function createKernelRuntime(options: CreateHostedSessionOptions, cwd: string): BrewvaRuntime {
  return (
    options.runtime ??
    new BrewvaRuntime({
      cwd,
      configPath: options.configPath,
      config: options.config,
      agentId: options.agentId,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
      routingScopes: options.routingScopes,
    })
  );
}

function installContextProviders(runtime: BrewvaRuntime): void {
  if (
    !runtime.context
      .listProviders()
      .some((provider) => provider.source === CONTEXT_SOURCES.narrativeMemory)
  ) {
    runtime.context.registerProvider(
      createNarrativeMemoryContextProvider({
        runtime,
      }),
    );
  }
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
}

function assertRoutingScopeCompatibility(
  runtime: BrewvaRuntime,
  options: CreateHostedSessionOptions,
): void {
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
}

function createDelegationStore(
  runtime: BrewvaRuntime,
  enabled: boolean,
): HostedDelegationStore | undefined {
  if (!enabled) {
    return undefined;
  }
  const delegationStore = new HostedDelegationStore(runtime);
  runtime.session.onClearState((sessionId) => {
    delegationStore.clearSession(sessionId);
  });
  return delegationStore;
}

function createDelegationQuery(delegationStore: HostedDelegationStore | undefined) {
  return delegationStore
    ? {
        listRuns: (sessionId: string, query?: Parameters<HostedDelegationStore["listRuns"]>[1]) =>
          delegationStore.listRuns(sessionId, query),
        listPendingOutcomes: (
          sessionId: string,
          query?: Parameters<HostedDelegationStore["listPendingOutcomes"]>[1],
        ) => delegationStore.listPendingOutcomes(sessionId, query),
      }
    : undefined;
}

function createHostedOrchestration(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaRuntime;
  delegationStore: HostedDelegationStore | undefined;
  cwd: string;
  modelRegistry: ModelRegistry;
}): BrewvaToolOrchestration | undefined {
  const { options, runtime, delegationStore, cwd, modelRegistry } = input;
  if (options.enableSubagents === false || options.orchestration?.subagents) {
    return options.orchestration;
  }

  const subagents = createHostedSubagentAdapter({
    runtime,
    modelRouting: createDelegationModelRoutingContext(modelRegistry),
    delegationStore,
    backgroundController: createDetachedSubagentBackgroundController({
      runtime,
      delegationStore,
      configPath: options.configPath,
      routingScopes: options.routingScopes,
      modelRouting: createDelegationModelRoutingContext(modelRegistry),
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
        contextProfile: childOptions.contextProfile,
        routingScopes: options.routingScopes,
        scopeId: options.scopeId,
      }),
  });
  return {
    ...options.orchestration,
    subagents,
  };
}

function createRuntimePlugins(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaRuntime;
  orchestration: BrewvaToolOrchestration | undefined;
  delegationStore: HostedDelegationStore | undefined;
  semanticOracle?: BrewvaSemanticOracle;
}): RuntimePlugin[] {
  const managedToolMode = resolveManagedToolMode(input.options.managedToolMode);
  const registerManagedTools = managedToolMode === "runtime_plugin";
  const runtimePlugins = [
    createHostedTurnPipeline({
      runtime: input.runtime,
      registerTools: registerManagedTools,
      orchestration: input.orchestration,
      delegationStore: input.delegationStore,
      managedToolNames: input.options.managedToolNames,
      contextProfile: input.options.contextProfile,
      semanticOracle: input.semanticOracle,
    }),
  ];
  if (input.options.runtimePlugins && input.options.runtimePlugins.length > 0) {
    runtimePlugins.push(...input.options.runtimePlugins);
  }
  return runtimePlugins;
}

function createDirectManagedTools(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaRuntime;
  orchestration: BrewvaToolOrchestration | undefined;
  delegationStore: HostedDelegationStore | undefined;
  managedToolMode: ManagedToolMode;
  semanticOracle?: BrewvaSemanticOracle;
}) {
  if (input.managedToolMode !== "direct") {
    return undefined;
  }
  return buildBrewvaTools({
    runtime: Object.assign(
      {},
      input.runtime,
      input.semanticOracle ? { semanticOracle: input.semanticOracle } : {},
    ),
    orchestration: input.orchestration,
    delegation: createDelegationQuery(input.delegationStore),
    toolNames: input.options.managedToolNames,
  });
}

function recordHostedBootstrap(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  cwd: string;
  managedToolMode: ManagedToolMode;
}): void {
  const skillLoadReport = input.runtime.skills.getLoadReport();
  input.runtime.events.record({
    sessionId: input.sessionId,
    type: "session_bootstrap",
    payload: {
      cwd: input.cwd,
      agentId: input.runtime.agentId,
      managedToolMode: input.managedToolMode,
      skillLoad: {
        routingEnabled: skillLoadReport.routingEnabled,
        routingScopes: skillLoadReport.routingScopes,
        routableSkills: skillLoadReport.routableSkills,
        hiddenSkills: skillLoadReport.hiddenSkills,
        overlaySkills: skillLoadReport.overlaySkills,
      },
    },
  });
}

export async function createHostedSession(
  options: CreateHostedSessionOptions = {},
): Promise<HostedSessionResult> {
  const environment = resolveHostedEnvironment(options);
  const runtime = createKernelRuntime(options, environment.cwd);
  installContextProviders(runtime);
  assertRoutingScopeCompatibility(runtime, options);

  const autoSubagentsEnabled = options.enableSubagents !== false;
  const delegationStore = createDelegationStore(runtime, autoSubagentsEnabled);
  const orchestration = createHostedOrchestration({
    options,
    runtime,
    delegationStore,
    cwd: environment.cwd,
    modelRegistry: environment.modelRegistry,
  });

  const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
  applyRuntimeUiSettings(settingsManager, runtime.config.ui);

  const managedToolMode = resolveManagedToolMode(options.managedToolMode);
  const semanticOracle = createHostedSemanticOracle({
    model: environment.selectedModel.model,
    modelRegistry: environment.modelRegistry,
    runtime,
  });
  const runtimePlugins = createRuntimePlugins({
    options,
    runtime,
    orchestration,
    delegationStore,
    semanticOracle,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager,
    extensionFactories: runtimePlugins,
  });
  await resourceLoader.reload();

  const customTools = createDirectManagedTools({
    options,
    runtime,
    orchestration,
    delegationStore,
    managedToolMode,
    semanticOracle,
  });
  const builtinTools = resolveBuiltinTools(options.builtinToolNames);

  const sessionResult = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    authStorage: environment.authStorage,
    modelRegistry: environment.modelRegistry,
    settingsManager,
    resourceLoader,
    model: environment.selectedModel.model,
    thinkingLevel: environment.selectedModel.thinkingLevel,
    tools: builtinTools,
    customTools,
  });

  const session = installSessionCompactionRecovery(sessionResult.session, { runtime });
  const sessionId = session.sessionManager.getSessionId();
  recordHostedBootstrap({
    runtime,
    sessionId,
    cwd: environment.cwd,
    managedToolMode,
  });

  return {
    ...sessionResult,
    session,
    runtime,
  };
}
