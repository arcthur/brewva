import { homedir } from "node:os";
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
  attachBrewvaToolExecutionTraits,
  buildBrewvaTools,
  resolveBrewvaModelSelection,
  type BrewvaToolExecutionTraits,
  type BrewvaSemanticOracle,
  type BrewvaToolOrchestration,
} from "@brewva/brewva-tools";
import {
  AuthStorage,
  createReadTool,
  createEditTool,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  type ReadToolDetails,
  type ReadToolOptions,
  SettingsManager,
  type ToolDefinition,
  createWriteTool,
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
import {
  createHostedToolExecutionCoordinator,
  wrapToolDefinitionWithHostedExecutionTraits,
  wrapToolDefinitionsWithHostedExecutionTraits,
  type HostedToolExecutionCoordinator,
} from "../tool-execution-traits.js";
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

function createStaticTextComponent(text: string): {
  render: (width: number) => string[];
  invalidate: () => void;
} {
  return {
    render: (_width) => (text.length > 0 ? text.split("\n") : []),
    invalidate: () => undefined,
  };
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function extractTextContent(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) {
    return "";
  }
  return result.content
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const text = (item as { type?: unknown; text?: unknown }).text;
      const type = (item as { type?: unknown }).type;
      return type === "text" && typeof text === "string" ? [text.replace(/\r/g, "")] : [];
    })
    .join("\n");
}

const READ_CONTINUATION_FOOTER =
  /\n\n(\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\])$/;

interface CompactReadTextOutput {
  body: string;
  continuationFooter?: string;
}

interface CompactReadToolInput {
  cwd: string;
  getReadToolOptions?: () => ReadToolOptions | undefined;
  createReadDelegate?: typeof createReadTool;
}

function splitCompactReadTextOutput(output: string): CompactReadTextOutput {
  const footerMatch = READ_CONTINUATION_FOOTER.exec(output);
  if (!footerMatch || typeof footerMatch.index !== "number") {
    return { body: output };
  }

  return {
    body: output.slice(0, footerMatch.index),
    continuationFooter: footerMatch[1],
  };
}

function countRenderedLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function formatLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

export function createCompactReadTool(
  input: CompactReadToolInput,
): ToolDefinition<ReturnType<typeof createReadTool>["parameters"], ReadToolDetails> {
  const createReadDelegate = input.createReadDelegate ?? createReadTool;
  const originalRead = createReadDelegate(input.cwd);
  return {
    name: originalRead.name,
    label: originalRead.label,
    description: originalRead.description,
    parameters: originalRead.parameters,
    execute(toolCallId, params, signal, onUpdate, _ctx) {
      return createReadDelegate(input.cwd, input.getReadToolOptions?.()).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const filePathCandidate = (args as { file_path?: unknown } | undefined)?.file_path;
      const rawPath =
        typeof args?.path === "string"
          ? args.path
          : typeof filePathCandidate === "string"
            ? filePathCandidate
            : "";
      const offset = typeof args?.offset === "number" ? args.offset : undefined;
      const limit = typeof args?.limit === "number" ? args.limit : undefined;
      let pathDisplay = rawPath
        ? theme.fg("accent", shortenPath(rawPath))
        : theme.fg("toolOutput", "...");

      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }

      return createStaticTextComponent(
        `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`,
      );
    },
    renderResult(result, { expanded }, theme) {
      const hasImage = Array.isArray(result.content)
        ? result.content.some(
            (item) =>
              item && typeof item === "object" && (item as { type?: unknown }).type === "image",
          )
        : false;
      if (hasImage) {
        return createStaticTextComponent(`\n${theme.fg("success", "Image loaded")}`);
      }

      const output = extractTextContent(result);
      if (!output) {
        return createStaticTextComponent("");
      }

      const details = result.details as ReadToolDetails | undefined;
      if (details?.truncation?.firstLineExceedsLimit) {
        if (!expanded) {
          return createStaticTextComponent(`\n${theme.fg("warning", "Line exceeds output limit")}`);
        }
        return createStaticTextComponent(`\n${theme.fg("warning", output)}`);
      }

      const { body, continuationFooter } = splitCompactReadTextOutput(output);
      const lineCount =
        details?.truncation?.truncated && typeof details.truncation.outputLines === "number"
          ? details.truncation.outputLines
          : countRenderedLines(body);

      if (!expanded) {
        let summary = theme.fg("success", formatLineCount(lineCount));
        if (details?.truncation?.truncated && typeof details.truncation.totalLines === "number") {
          summary += theme.fg("warning", ` (truncated from ${details.truncation.totalLines})`);
        }
        return createStaticTextComponent(`\n${summary}`);
      }

      const renderedLines = body
        .split("\n")
        .filter((_line, index, lines) => !(lines.length === 1 && lines[0] === ""))
        .map((line) => theme.fg("toolOutput", line));

      if (details?.truncation?.truncated) {
        if (details.truncation.firstLineExceedsLimit) {
          renderedLines.push(theme.fg("warning", "[First line exceeds output limit]"));
        } else if (details.truncation.truncatedBy === "lines") {
          renderedLines.push(
            theme.fg(
              "warning",
              `[Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines]`,
            ),
          );
        } else {
          renderedLines.push(
            theme.fg("warning", `[Truncated: ${details.truncation.outputLines} lines shown]`),
          );
        }
      } else if (continuationFooter) {
        renderedLines.push(theme.fg("warning", continuationFooter));
      }

      return createStaticTextComponent(
        renderedLines.length > 0 ? `\n${renderedLines.join("\n")}` : "",
      );
    },
  };
}

const READ_EXECUTION_TRAITS: BrewvaToolExecutionTraits = {
  concurrencySafe: true,
  interruptBehavior: "cancel",
  streamingEligible: false,
  contextModifying: false,
};

const MUTATING_FILE_EXECUTION_TRAITS: BrewvaToolExecutionTraits = {
  concurrencySafe: false,
  interruptBehavior: "block",
  streamingEligible: false,
  contextModifying: true,
};

function createHostedCustomTools(input: {
  cwd: string;
  settingsManager: SettingsManager;
  builtinToolNames: readonly HostedDelegationBuiltinToolName[] | undefined;
  directManagedTools: ReturnType<typeof createDirectManagedTools>;
  toolExecutionCoordinator: HostedToolExecutionCoordinator;
}): ToolDefinition[] | undefined {
  const tools: ToolDefinition[] = [];
  const requestedBuiltinTools = new Set(input.builtinToolNames ?? ["read", "edit", "write"]);

  if (requestedBuiltinTools.has("read")) {
    const compactReadTool = attachBrewvaToolExecutionTraits(
      createCompactReadTool({
        cwd: input.cwd,
        getReadToolOptions: () => ({
          autoResizeImages: input.settingsManager.getImageAutoResize(),
        }),
      }) as unknown as ToolDefinition,
      READ_EXECUTION_TRAITS,
    );
    tools.push(
      wrapToolDefinitionWithHostedExecutionTraits(compactReadTool, input.toolExecutionCoordinator),
    );
  }

  if (requestedBuiltinTools.has("edit")) {
    const editDefinition = attachBrewvaToolExecutionTraits(
      createEditTool(input.cwd),
      MUTATING_FILE_EXECUTION_TRAITS,
    );
    tools.push(
      wrapToolDefinitionWithHostedExecutionTraits(editDefinition, input.toolExecutionCoordinator),
    );
  }

  if (requestedBuiltinTools.has("write")) {
    const writeDefinition = attachBrewvaToolExecutionTraits(
      createWriteTool(input.cwd),
      MUTATING_FILE_EXECUTION_TRAITS,
    );
    tools.push(
      wrapToolDefinitionWithHostedExecutionTraits(writeDefinition, input.toolExecutionCoordinator),
    );
  }

  if (input.directManagedTools && input.directManagedTools.length > 0) {
    tools.push(...input.directManagedTools);
  }

  return tools.length > 0 ? tools : undefined;
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
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
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
  toolExecutionCoordinator: HostedToolExecutionCoordinator;
  hostedToolDefinitionsByName?: ReadonlyMap<string, ToolDefinition>;
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
      toolExecutionCoordinator: input.toolExecutionCoordinator,
      hostedToolDefinitionsByName: input.hostedToolDefinitionsByName,
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
        loadedSkills: skillLoadReport.loadedSkills,
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
  const toolExecutionCoordinator = createHostedToolExecutionCoordinator();
  const directManagedTools = wrapToolDefinitionsWithHostedExecutionTraits(
    createDirectManagedTools({
      options,
      runtime,
      orchestration,
      delegationStore,
      managedToolMode,
      semanticOracle,
    }),
    toolExecutionCoordinator,
  );
  const customTools = createHostedCustomTools({
    cwd: environment.cwd,
    settingsManager,
    builtinToolNames: options.builtinToolNames,
    directManagedTools,
    toolExecutionCoordinator,
  });
  const hostedToolDefinitionsByName = new Map<string, ToolDefinition>();
  for (const tool of customTools ?? []) {
    hostedToolDefinitionsByName.set(tool.name, tool);
  }
  const runtimePlugins = createRuntimePlugins({
    options,
    runtime,
    orchestration,
    delegationStore,
    semanticOracle,
    toolExecutionCoordinator,
    hostedToolDefinitionsByName,
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager,
    extensionFactories: runtimePlugins,
  });
  await resourceLoader.reload();

  const sessionResult = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    authStorage: environment.authStorage,
    modelRegistry: environment.modelRegistry,
    settingsManager,
    resourceLoader,
    model: environment.selectedModel.model,
    thinkingLevel: environment.selectedModel.thinkingLevel,
    tools: [],
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
