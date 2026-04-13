import { homedir } from "node:os";
import { resolve } from "node:path";
import { createRecallContextProvider } from "@brewva/brewva-recall";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  createToolRuntimePort,
  createTrustedLocalGovernancePort,
  resolveBrewvaAgentDir,
  type CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions,
  type ManagedToolMode,
} from "@brewva/brewva-runtime";
import { createToolRuntimeInternalPort, recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type {
  BrewvaManagedPromptSession,
  BrewvaModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate";
import {
  attachBrewvaToolExecutionTraits,
  buildReadPathDiscoveryObservationPayload,
  buildBrewvaTools,
  resolveBrewvaModelSelection,
  type BrewvaToolExecutionTraits,
  type BrewvaSemanticReranker,
  type BrewvaToolOrchestration,
} from "@brewva/brewva-tools";
import { createHostedTurnPipeline, type RuntimePlugin } from "../runtime-plugins/index.js";
import {
  analyzeReadPathRecoveryState,
  isReadPathVerified,
  recordReadPathGuardWarning,
} from "../runtime-plugins/read-path-recovery.js";
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
import {
  createHostedEditTool,
  createHostedReadTool,
  createHostedSessionDriver,
  createHostedSettingsManager,
  createHostedWriteTool,
  type HostedSessionDriver,
  type HostedSessionCustomTool,
  type HostedSessionReadToolDetails,
  type HostedSessionReadToolOptions,
  type HostedSessionSettingsView,
} from "./hosted-session-driver.js";
import { DEFAULT_HOSTED_ROUTING_SCOPES } from "./routing-defaults.js";
import { createHostedSemanticReranker } from "./semantic-reranker.js";

export type HostedSession = BrewvaManagedPromptSession;

export interface HostedSessionResult {
  session: HostedSession;
  runtime: BrewvaRuntime;
  modelFallbackMessage?: string;
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
  sessionDriver: HostedSessionDriver;
  requestedModelSelection: ReturnType<typeof resolveBrewvaModelSelection>;
}

interface HostedToolRenderTheme {
  bold(text: string): string;
  fg(tone: string, text: string): string;
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
  runtime?: BrewvaRuntime;
  getReadToolOptions?: () => HostedSessionReadToolOptions | undefined;
  createReadDelegate?: typeof createHostedReadTool;
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

function resolveRequestedReadPath(args: Record<string, unknown> | undefined): string | undefined {
  const raw =
    (typeof args?.path === "string" ? args.path : undefined) ??
    (typeof args?.file_path === "string" ? args.file_path : undefined) ??
    (typeof args?.filePath === "string" ? args.filePath : undefined);
  const normalized = raw?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveReadSessionId(ctx: unknown): string | undefined {
  const sessionId = (
    ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined
  )?.sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
}

function buildReadPathGuardResult(input: {
  requestedPath: string;
  state: ReturnType<typeof analyzeReadPathRecoveryState>;
}) {
  const lines = [
    "[ReadPathGuard]",
    `Blocked direct \`read\` after ${input.state.consecutiveMissingPathFailures} consecutive path-not-found failures.`,
    "Read is now gated by discovery evidence.",
    input.state.phase === "required"
      ? "Run repository discovery or inspect a known existing file before retrying `read`."
      : "Retry `read` only for paths that were observed directly or live under observed directories.",
    `requested_path: ${input.requestedPath}`,
  ];
  if (input.state.observedDirectories.length > 0) {
    lines.push(`observed_directories: ${input.state.observedDirectories.slice(0, 8).join(", ")}`);
  }
  if (input.state.observedPaths.length > 0) {
    lines.push(`observed_paths: ${input.state.observedPaths.slice(0, 8).join(", ")}`);
  }
  if (input.state.failedPaths.length > 0) {
    lines.push(`recent_failed_paths: ${input.state.failedPaths.slice(0, 4).join(", ")}`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      verdict: "fail" as const,
      requestedPath: input.requestedPath,
      recentFailedPaths: input.state.failedPaths,
      observedPaths: input.state.observedPaths,
      observedDirectories: input.state.observedDirectories,
      consecutiveMissingPathFailures: input.state.consecutiveMissingPathFailures,
      phase: input.state.phase,
      recoveryHint: "path_discovery_required_after_missing_path_failures",
    },
  };
}

function didReadToolSucceed(result: { details?: unknown } | undefined): boolean {
  const details = result?.details as { verdict?: unknown; ok?: unknown } | undefined;
  if (details?.verdict === "fail" || details?.ok === false) {
    return false;
  }
  return true;
}

export function createCompactReadTool(input: CompactReadToolInput): HostedSessionCustomTool {
  const createReadDelegate = input.createReadDelegate ?? createHostedReadTool;
  const originalRead = createReadDelegate(input.cwd);
  const tool: typeof originalRead = {
    name: originalRead.name,
    label: originalRead.label,
    description: originalRead.description,
    parameters: originalRead.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = resolveRequestedReadPath(params as Record<string, unknown> | undefined);
      const sessionId = resolveReadSessionId(ctx);
      if (input.runtime && requestedPath && sessionId) {
        const recoveryState = analyzeReadPathRecoveryState(input.runtime, sessionId);
        if (recoveryState.active && !isReadPathVerified(recoveryState, requestedPath, input.cwd)) {
          recordReadPathGuardWarning(input.runtime, {
            sessionId,
            requestedPath,
            state: recoveryState,
          });
          return buildReadPathGuardResult({
            requestedPath,
            state: recoveryState,
          }) as unknown as Awaited<ReturnType<HostedSessionCustomTool["execute"]>>;
        }
      }

      const result = await createReadDelegate(input.cwd, input.getReadToolOptions?.()).execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
      if (input.runtime && requestedPath && sessionId && didReadToolSucceed(result)) {
        const discoveryPayload = buildReadPathDiscoveryObservationPayload({
          baseCwd: input.cwd,
          toolName: "read",
          evidenceKind: "direct_file_access",
          observedPaths: [requestedPath],
        });
        if (discoveryPayload) {
          recordRuntimeEvent(input.runtime, {
            sessionId,
            type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
            payload: discoveryPayload,
          });
        }
      }
      return result;
    },
    renderCall(args, theme) {
      const renderTheme = theme as HostedToolRenderTheme;
      const normalizedArgs = args as Record<string, unknown> | undefined;
      const filePathCandidate = normalizedArgs?.file_path;
      const rawPath =
        typeof normalizedArgs?.path === "string"
          ? normalizedArgs.path
          : typeof filePathCandidate === "string"
            ? filePathCandidate
            : "";
      const offset = typeof normalizedArgs?.offset === "number" ? normalizedArgs.offset : undefined;
      const limit = typeof normalizedArgs?.limit === "number" ? normalizedArgs.limit : undefined;
      let pathDisplay = rawPath
        ? renderTheme.fg("accent", shortenPath(rawPath))
        : renderTheme.fg("toolOutput", "...");

      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        pathDisplay += renderTheme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }

      return createStaticTextComponent(
        `${renderTheme.fg("toolTitle", renderTheme.bold("read"))} ${pathDisplay}`,
      );
    },
    renderResult(result, { expanded }, theme) {
      const renderTheme = theme as HostedToolRenderTheme;
      const hasImage = Array.isArray(result.content)
        ? result.content.some(
            (item) =>
              item && typeof item === "object" && (item as { type?: unknown }).type === "image",
          )
        : false;
      if (hasImage) {
        return createStaticTextComponent(`\n${renderTheme.fg("success", "Image loaded")}`);
      }

      const output = extractTextContent(result);
      if (!output) {
        return createStaticTextComponent("");
      }

      const details = result.details as HostedSessionReadToolDetails | undefined;
      if (details?.truncation?.firstLineExceedsLimit) {
        if (!expanded) {
          return createStaticTextComponent(
            `\n${renderTheme.fg("warning", "Line exceeds output limit")}`,
          );
        }
        return createStaticTextComponent(`\n${renderTheme.fg("warning", output)}`);
      }

      const { body, continuationFooter } = splitCompactReadTextOutput(output);
      const lineCount =
        details?.truncation?.truncated && typeof details.truncation.outputLines === "number"
          ? details.truncation.outputLines
          : countRenderedLines(body);

      if (!expanded) {
        let summary = renderTheme.fg("success", formatLineCount(lineCount));
        if (details?.truncation?.truncated && typeof details.truncation.totalLines === "number") {
          summary += renderTheme.fg(
            "warning",
            ` (truncated from ${details.truncation.totalLines})`,
          );
        }
        return createStaticTextComponent(`\n${summary}`);
      }

      const renderedLines = body
        .split("\n")
        .filter((_line, index, lines) => !(lines.length === 1 && lines[0] === ""))
        .map((line) => renderTheme.fg("toolOutput", line));

      if (details?.truncation?.truncated) {
        if (details.truncation.firstLineExceedsLimit) {
          renderedLines.push(renderTheme.fg("warning", "[First line exceeds output limit]"));
        } else if (details.truncation.truncatedBy === "lines") {
          renderedLines.push(
            renderTheme.fg(
              "warning",
              `[Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines]`,
            ),
          );
        } else {
          renderedLines.push(
            renderTheme.fg("warning", `[Truncated: ${details.truncation.outputLines} lines shown]`),
          );
        }
      } else if (continuationFooter) {
        renderedLines.push(renderTheme.fg("warning", continuationFooter));
      }

      return createStaticTextComponent(
        renderedLines.length > 0 ? `\n${renderedLines.join("\n")}` : "",
      );
    },
  };
  return tool;
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
  runtime: BrewvaRuntime;
  settingsManager: HostedSessionSettingsView;
  builtinToolNames: readonly HostedDelegationBuiltinToolName[] | undefined;
  directManagedTools: ReturnType<typeof createDirectManagedTools>;
  toolExecutionCoordinator: HostedToolExecutionCoordinator;
}): HostedSessionCustomTool[] | undefined {
  const tools: HostedSessionCustomTool[] = [];
  const requestedBuiltinTools = new Set(input.builtinToolNames ?? ["read", "edit", "write"]);

  if (requestedBuiltinTools.has("read")) {
    const compactReadTool = attachBrewvaToolExecutionTraits(
      createCompactReadTool({
        cwd: input.cwd,
        runtime: input.runtime,
        getReadToolOptions: () => ({
          autoResizeImages: input.settingsManager.getImageAutoResize(),
        }),
      }),
      READ_EXECUTION_TRAITS,
    );
    tools.push(
      wrapToolDefinitionWithHostedExecutionTraits(compactReadTool, input.toolExecutionCoordinator),
    );
  }

  if (requestedBuiltinTools.has("edit")) {
    const editDefinition = attachBrewvaToolExecutionTraits(
      createHostedEditTool(input.cwd),
      MUTATING_FILE_EXECUTION_TRAITS,
    );
    tools.push(
      wrapToolDefinitionWithHostedExecutionTraits(editDefinition, input.toolExecutionCoordinator),
    );
  }

  if (requestedBuiltinTools.has("write")) {
    const writeDefinition = attachBrewvaToolExecutionTraits(
      createHostedWriteTool(input.cwd),
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
  settingsManager: HostedSessionSettingsView,
  uiConfig: BrewvaRuntime["config"]["ui"],
): void {
  settingsManager.applyOverrides({
    quietStartup: uiConfig.quietStartup,
  });
}

function toRegisteredSemanticModel(
  model: HostedSession["model"] | undefined,
  modelCatalog: Pick<BrewvaModelCatalog, "find">,
): BrewvaRegisteredModel | undefined {
  if (!model) {
    return undefined;
  }
  return (
    modelCatalog.find(model.provider, model.id) ?? {
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.displayName ?? model.id,
      api: model.api ?? "openai-responses",
      baseUrl: model.baseUrl ?? "",
      reasoning: model.reasoning,
      input: model.input ?? ["text"],
      cost: model.cost ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.headers ? { headers: model.headers } : {}),
      ...(model.compat != null ? { compat: model.compat } : {}),
      ...(model.displayName ? { displayName: model.displayName } : {}),
    }
  );
}

function resolveManagedToolMode(mode: ManagedToolMode | undefined): ManagedToolMode {
  return mode === "direct" ? "direct" : "runtime_plugin";
}

function resolveHostedEnvironment(options: CreateHostedSessionOptions): HostedEnvironment {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolveBrewvaAgentDir();

  const sessionDriver = createHostedSessionDriver(agentDir);
  const requestedModelSelection = resolveBrewvaModelSelection(
    options.model,
    sessionDriver.modelCatalog,
  );

  return {
    cwd,
    agentDir,
    sessionDriver,
    requestedModelSelection,
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
      routingDefaultScopes:
        options.routingScopes && options.routingScopes.length > 0
          ? options.routingDefaultScopes
          : (options.routingDefaultScopes ?? [...DEFAULT_HOSTED_ROUTING_SCOPES]),
    })
  );
}

function installContextProviders(runtime: BrewvaRuntime): void {
  if (
    !runtime.inspect.context
      .listProviders()
      .some((provider) => provider.source === CONTEXT_SOURCES.recallBroker)
  ) {
    runtime.maintain.context.registerProvider(
      createRecallContextProvider({
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
  if (options.runtime && options.routingDefaultScopes && options.routingDefaultScopes.length > 0) {
    throw new Error(
      "routingDefaultScopes must be applied when constructing BrewvaRuntime; createHostedSession does not infer runtime config intent from an existing runtime",
    );
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
  runtime.maintain.session.onClearState((sessionId) => {
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
  modelCatalog: Pick<BrewvaModelCatalog, "getAll">;
}): BrewvaToolOrchestration | undefined {
  const { options, runtime, delegationStore, cwd, modelCatalog } = input;
  if (options.enableSubagents === false || options.orchestration?.subagents) {
    return options.orchestration;
  }

  const subagents = createHostedSubagentAdapter({
    runtime,
    modelRouting: createDelegationModelRoutingContext(modelCatalog),
    delegationStore,
    backgroundController: createDetachedSubagentBackgroundController({
      runtime,
      delegationStore,
      configPath: options.configPath,
      routingScopes: options.routingScopes,
      modelRouting: createDelegationModelRoutingContext(modelCatalog),
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
  semanticReranker?: BrewvaSemanticReranker;
  toolExecutionCoordinator: HostedToolExecutionCoordinator;
  hostedToolDefinitionsByName?: ReadonlyMap<string, HostedSessionCustomTool>;
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
      semanticReranker: input.semanticReranker,
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
  semanticReranker?: BrewvaSemanticReranker;
}) {
  if (input.managedToolMode !== "direct") {
    return undefined;
  }
  return buildBrewvaTools({
    runtime: {
      ...createToolRuntimePort(input.runtime),
      internal: createToolRuntimeInternalPort(input.runtime),
      ...(input.semanticReranker ? { semanticReranker: input.semanticReranker } : {}),
    },
    orchestration: input.orchestration,
    delegation: createDelegationQuery(input.delegationStore),
    toolNames: input.options.managedToolNames,
  });
}

function recordHostedBootstrap(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  cwd: string;
  configPath?: string;
  managedToolMode: ManagedToolMode;
}): void {
  const skillLoadReport = input.runtime.inspect.skills.getLoadReport();
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: "session_bootstrap",
    payload: {
      cwd: input.cwd,
      agentId: input.runtime.agentId,
      managedToolMode: input.managedToolMode,
      runtimeConfig: {
        workspaceRoot: input.runtime.workspaceRoot,
        configPath: input.configPath ?? null,
        artifactRoots: {
          eventsDir: input.runtime.config.infrastructure.events.dir,
          recoveryWalDir: input.runtime.config.infrastructure.recoveryWal.dir,
          projectionDir: input.runtime.config.projection.dir,
          ledgerPath: input.runtime.config.ledger.path,
        },
      },
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
    modelCatalog: environment.sessionDriver.modelCatalog,
  });

  const settings = createHostedSettingsManager(environment.cwd, environment.agentDir);
  applyRuntimeUiSettings(settings.view, runtime.config.ui);

  const managedToolMode = resolveManagedToolMode(options.managedToolMode);
  let activeSemanticModel = environment.requestedModelSelection.model;
  const semanticReranker = createHostedSemanticReranker({
    resolveModel: () => activeSemanticModel,
    modelCatalog: environment.sessionDriver.modelCatalog,
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
      semanticReranker,
    }),
    toolExecutionCoordinator,
  );
  const customTools = createHostedCustomTools({
    cwd: environment.cwd,
    runtime,
    settingsManager: settings.view,
    builtinToolNames: options.builtinToolNames,
    directManagedTools,
    toolExecutionCoordinator,
  });
  const hostedToolDefinitionsByName = new Map<string, HostedSessionCustomTool>();
  for (const tool of customTools ?? []) {
    hostedToolDefinitionsByName.set(tool.name, tool);
  }
  const runtimePlugins = createRuntimePlugins({
    options,
    runtime,
    orchestration,
    delegationStore,
    semanticReranker,
    toolExecutionCoordinator,
    hostedToolDefinitionsByName,
  });

  const sessionRuntime = await environment.sessionDriver.createRuntime({
    cwd: environment.cwd,
    settings,
    runtime,
    runtimePlugins,
    requestedModel: environment.requestedModelSelection.model,
    requestedThinkingLevel: environment.requestedModelSelection.thinkingLevel,
    customTools,
  });
  activeSemanticModel =
    toRegisteredSemanticModel(
      sessionRuntime.session.model,
      environment.sessionDriver.modelCatalog,
    ) ?? activeSemanticModel;

  const session = installSessionCompactionRecovery(sessionRuntime.session, {
    runtime,
  });
  const sessionId = session.sessionManager.getSessionId();
  recordHostedBootstrap({
    runtime,
    sessionId,
    cwd: environment.cwd,
    configPath: options.configPath,
    managedToolMode,
  });

  return {
    session,
    runtime,
    modelFallbackMessage: sessionRuntime.modelFallbackMessage,
  };
}
