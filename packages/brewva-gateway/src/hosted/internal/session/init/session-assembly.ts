import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type { CreateBrewvaSessionOptions as RuntimeCreateBrewvaSessionOptions } from "@brewva/brewva-runtime/session";
import { sha256Hex, stableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import type {
  BrewvaToolExecutionTraits,
  BrewvaToolOrchestration,
} from "@brewva/brewva-tools/contracts";
import { buildReadPathDiscoveryObservationPayload } from "@brewva/brewva-tools/navigation";
import { attachBrewvaToolExecutionTraits } from "@brewva/brewva-tools/registry";
import { type HostedDelegationBuiltinToolName } from "../../../../delegation/api.js";
import { type HostedExtensionPlugin, type LocalHookPort } from "../../../../extensions/api.js";
import { installSessionCompactionRecovery } from "../../compaction/recovery.js";
import { rememberHostedVisibleReadState } from "../../context/materialization.js";
import {
  analyzeReadPathRecoveryState,
  isReadPathVerified,
  recordReadPathGuardWarning,
} from "../../context/read-path-recovery.js";
import { createReadUnchangedState } from "../../provider/cache/index.js";
import type { ProviderConnectionSeams } from "../../provider/connection-types.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import {
  createHostedEditTool,
  createHostedReadTool,
  createHostedSettingsManager,
  createHostedWriteTool,
  type HostedSessionCustomTool,
  type HostedSessionReadToolDetails,
  type HostedSessionReadToolOptions,
  type HostedSessionSettingsView,
} from "../session-factory.js";
import type { HostedSessionPhase } from "../session-phase/api.js";
import { findModelPreset } from "../settings/model-presets.js";
import {
  createHostedToolExecutionCoordinator,
  wrapToolDefinitionWithHostedExecutionTraits,
  wrapToolDefinitionsWithHostedExecutionTraits,
  type HostedToolExecutionCoordinator,
} from "../tools/execution-traits.js";
import {
  applyRuntimeUiSettings,
  assertRoutingScopeCompatibility,
  createKernelRuntime,
  resolveHostedEnvironment,
  resolveManagedToolMode,
} from "./environment.js";
import {
  createHostedMcpEventRecorder,
  installHostedMcpBundleDisposal,
  recordHostedBootstrap,
} from "./mcp-lifecycle.js";
import {
  createHostedMcpToolBundle,
  createHostedMcpToolSourcesFromConfig,
  type HostedSessionMcpToolSource,
} from "./mcp-tools.js";
import {
  createDelegationStore,
  createDirectManagedTools,
  createHostedOrchestration,
  createExtensions,
} from "./orchestration.js";
import { createHostedSessionInitPhases } from "./session-lifecycle.js";

export type HostedSession = BrewvaManagedPromptSession;

const READ_SIGNATURE_CONTENT_HASH_MAX_BYTES = 1024 * 1024;

export interface HostedSessionResult {
  session: HostedSession;
  runtime: BrewvaHostedRuntimePort;
  providerConnections?: ProviderConnectionSeams;
  initPhases: readonly HostedSessionPhase[];
  phase: HostedSessionPhase;
  modelFallbackMessage?: string;
  orchestration?: BrewvaToolOrchestration;
}

export interface CreateHostedSessionOptions extends RuntimeCreateBrewvaSessionOptions {
  runtime?: BrewvaRuntime | BrewvaHostedRuntimePort;
  extensions?: HostedExtensionPlugin[];
  localHooks?: readonly LocalHookPort[];
  orchestration?: BrewvaToolOrchestration;
  customTools?: readonly HostedSessionCustomTool[];
  mcpToolSources?: readonly HostedSessionMcpToolSource[];
  managedToolNames?: readonly string[];
  builtinToolNames?: readonly HostedDelegationBuiltinToolName[];
  enableSubagents?: boolean;
  scopeId?: string;
  sessionId?: string;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
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
  runtime?: BrewvaHostedRuntimePort;
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

function isTextReadResult(result: { content?: unknown } | undefined): boolean {
  if (!Array.isArray(result?.content)) {
    return false;
  }
  return !result.content.some(
    (item) => item && typeof item === "object" && (item as { type?: unknown }).type === "image",
  );
}

function buildReadStateKey(cwd: string, requestedPath: string, params: Record<string, unknown>) {
  return {
    path: resolve(cwd, requestedPath),
    offset: typeof params.offset === "number" ? Math.max(0, Math.trunc(params.offset)) : 0,
    limit: typeof params.limit === "number" ? Math.max(0, Math.trunc(params.limit)) : null,
    encoding: "utf8",
  };
}

function readFileSignature(path: string) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      return undefined;
    }
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash:
        stat.size <= READ_SIGNATURE_CONTENT_HASH_MAX_BYTES ? sha256Hex(readFileSync(path)) : null,
    };
  } catch {
    return undefined;
  }
}

function resolveVisibleReadHistoryEpoch(
  runtime: BrewvaHostedRuntimePort | undefined,
  sessionId: string,
): number {
  return runtime?.inspect.context.visibleRead.getEpoch(sessionId) ?? 0;
}

function buildReadSignatureHash(input: {
  key: ReturnType<typeof buildReadStateKey>;
  signature: ReturnType<typeof readFileSignature>;
}): string {
  return stableJsonSha256Hex({
    path: input.key.path,
    offset: input.key.offset,
    limit: input.key.limit,
    encoding: input.key.encoding,
    size: input.signature?.size ?? null,
    mtimeMs: input.signature?.mtimeMs ?? null,
    contentHash: input.signature?.contentHash ?? null,
  });
}

export function createCompactReadTool(input: CompactReadToolInput): HostedSessionCustomTool {
  const createReadDelegate = input.createReadDelegate ?? createHostedReadTool;
  const originalRead = createReadDelegate(input.cwd);
  const readUnchangedState = createReadUnchangedState();
  input.runtime?.operator.session.state.onClear((sessionId) => readUnchangedState.clear(sessionId));
  const tool: typeof originalRead = {
    name: originalRead.name,
    label: originalRead.label,
    description: originalRead.description,
    parameters: originalRead.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = resolveRequestedReadPath(params as Record<string, unknown> | undefined);
      const sessionId = resolveReadSessionId(ctx);
      const readKey =
        requestedPath && sessionId
          ? buildReadStateKey(input.cwd, requestedPath, params as Record<string, unknown>)
          : undefined;
      const signature = readKey ? readFileSignature(readKey.path) : undefined;
      const visibleHistoryEpoch = sessionId
        ? resolveVisibleReadHistoryEpoch(input.runtime, sessionId)
        : 0;
      if (sessionId && readKey && signature) {
        const unchanged = readUnchangedState.match({
          sessionId,
          key: readKey,
          signature,
          visibleHistoryEpoch,
        });
        const visibleReadState = unchanged
          ? {
              path: readKey.path,
              offset: readKey.offset,
              limit: readKey.limit,
              encoding: readKey.encoding,
              signatureHash: buildReadSignatureHash({ key: readKey, signature }),
              visibleHistoryEpoch: unchanged.visibleHistoryEpoch,
              previousReadId: unchanged.previousReadId,
            }
          : undefined;
        const priorContentStillVisible =
          !visibleReadState ||
          !input.runtime ||
          input.runtime.inspect.context.visibleRead.isCurrent(sessionId, visibleReadState);
        if (unchanged && priorContentStillVisible) {
          return {
            content: [
              {
                type: "text",
                text: `File unchanged since previous visible read: ${requestedPath}`,
              },
            ],
            details: {
              ok: true,
              unchanged: {
                path: requestedPath,
                previousReadId: unchanged.previousReadId,
                visibleHistoryEpoch: unchanged.visibleHistoryEpoch,
              },
            },
          } as unknown as Awaited<ReturnType<HostedSessionCustomTool["execute"]>>;
        }
      }
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
      if (sessionId && readKey && didReadToolSucceed(result) && isTextReadResult(result)) {
        const recordedSignature = readFileSignature(readKey.path);
        if (recordedSignature) {
          readUnchangedState.recordFullRead({
            sessionId,
            key: readKey,
            signature: recordedSignature,
            visibleHistoryEpoch,
            readId: toolCallId,
          });
          if (input.runtime) {
            rememberHostedVisibleReadState({
              runtime: input.runtime,
              sessionId,
              state: {
                path: readKey.path,
                offset: readKey.offset,
                limit: readKey.limit,
                encoding: readKey.encoding,
                signatureHash: buildReadSignatureHash({
                  key: readKey,
                  signature: recordedSignature,
                }),
                visibleHistoryEpoch,
                previousReadId: toolCallId,
              },
            });
          }
        }
      }
      if (input.runtime && requestedPath && sessionId && didReadToolSucceed(result)) {
        const discoveryPayload = buildReadPathDiscoveryObservationPayload({
          baseCwd: input.cwd,
          toolName: "read",
          evidenceKind: "direct_file_access",
          observedPaths: [requestedPath],
        });
        if (discoveryPayload) {
          input.runtime.extensions.hosted.events.record({
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
  runtime: BrewvaHostedRuntimePort;
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

export async function createHostedSession(
  options: CreateHostedSessionOptions = {},
): Promise<HostedSessionResult> {
  const environment = resolveHostedEnvironment(options);
  const runtime = createKernelRuntime(options, environment.cwd);
  assertRoutingScopeCompatibility(runtime, options);

  const autoSubagentsEnabled = options.enableSubagents !== false;
  const delegationStore = createDelegationStore(runtime, autoSubagentsEnabled);
  const settings = createHostedSettingsManager(environment.cwd, environment.agentDir);
  applyRuntimeUiSettings(settings.view, runtime.config.ui);
  let activeSession: BrewvaManagedPromptSession | undefined;
  const orchestration = createHostedOrchestration({
    options,
    runtime,
    delegationStore,
    cwd: environment.cwd,
    modelCatalog: environment.sessionFactory.modelCatalog,
    createChildSession: (childOptions) => createHostedSession(childOptions),
    getActiveModelPreset: () => {
      const state = activeSession?.getModelPresetState?.();
      return state ? findModelPreset(state) : undefined;
    },
  });

  const managedToolMode = resolveManagedToolMode(options.managedToolMode);
  const toolExecutionCoordinator = createHostedToolExecutionCoordinator();
  const mcpEventRecorder = createHostedMcpEventRecorder(runtime);
  const configuredMcpToolSources = createHostedMcpToolSourcesFromConfig(
    runtime.config.integrations.mcp,
    {
      recordEvent: (event) => mcpEventRecorder.record(event),
    },
  );
  const mcpToolSources = [...configuredMcpToolSources, ...(options.mcpToolSources ?? [])];
  const directManagedTools = wrapToolDefinitionsWithHostedExecutionTraits(
    createDirectManagedTools({
      options,
      runtime,
      orchestration,
      delegationStore,
      managedToolMode,
    }),
    toolExecutionCoordinator,
  );
  const builtinCustomTools =
    createHostedCustomTools({
      cwd: environment.cwd,
      runtime,
      settingsManager: settings.view,
      builtinToolNames: options.builtinToolNames,
      directManagedTools,
      toolExecutionCoordinator,
    }) ?? [];
  const providedCustomTools =
    wrapToolDefinitionsWithHostedExecutionTraits(
      [...(options.customTools ?? [])],
      toolExecutionCoordinator,
    ) ?? [];
  const mcpToolBundle = await createHostedMcpToolBundle(mcpToolSources, {
    recordEvent: (event) => mcpEventRecorder.record(event),
  });
  const mcpCustomTools =
    wrapToolDefinitionsWithHostedExecutionTraits(
      mcpToolBundle?.tools ?? [],
      toolExecutionCoordinator,
    ) ?? [];
  const customTools = [...builtinCustomTools, ...providedCustomTools, ...mcpCustomTools];
  const hostedToolDefinitionsByName = new Map<string, HostedSessionCustomTool>();
  for (const tool of customTools) {
    if (hostedToolDefinitionsByName.has(tool.name)) {
      throw new Error(`Duplicate hosted tool name: ${tool.name}`);
    }
    hostedToolDefinitionsByName.set(tool.name, tool);
  }
  const extensions = createExtensions({
    options,
    runtime,
    orchestration,
    delegationStore,
    toolExecutionCoordinator,
    hostedToolDefinitionsByName,
    managedToolMode,
  });

  const sessionRuntime = await environment.sessionFactory.createRuntime({
    cwd: environment.cwd,
    settings,
    runtime,
    extensions,
    requestedModel: environment.requestedModelSelection.model,
    requestedThinkingLevel: environment.requestedModelSelection.thinkingLevel,
    customTools,
    sessionId: options.sessionId,
    ui: options.ui,
    logger: options.logger,
  });
  activeSession = sessionRuntime.session;

  let session = installSessionCompactionRecovery(sessionRuntime.session, {
    runtime,
  });
  const sessionId = session.sessionManager.getSessionId();
  const initPhases = createHostedSessionInitPhases({
    sessionId: asBrewvaSessionId(sessionId),
    providerApi: environment.requestedModelSelection.model?.api,
    toolNames: customTools.map((tool) => tool.name),
  });
  mcpEventRecorder.setSessionId(sessionId);
  session = installHostedMcpBundleDisposal(session, runtime, sessionId, mcpToolBundle);
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
    providerConnections: sessionRuntime.services.providerConnections,
    initPhases,
    phase: initPhases[initPhases.length - 1] ?? {
      kind: "ready",
      sessionId: asBrewvaSessionId(sessionId),
    },
    modelFallbackMessage: sessionRuntime.modelFallbackMessage,
    orchestration,
  };
}
