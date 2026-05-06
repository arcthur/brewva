import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  buildProviderCacheBucketKey,
  resolveProviderCacheCapability,
} from "@brewva/brewva-provider-core/cache";
import type {
  Api,
  ProviderPayloadMetadata,
  ProviderCachePolicy,
  ProviderRequestFingerprint,
} from "@brewva/brewva-provider-core/contracts";
import { clearApiProviderSessions } from "@brewva/brewva-provider-core/registry";
import type {
  BrewvaRuntime,
  ExpectedProviderCacheBreak,
  ProviderCacheRenderState,
  SessionLifecycleSnapshot,
  SessionWireFrame,
} from "@brewva/brewva-runtime";
import {
  MODEL_SELECT_EVENT_TYPE,
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import {
  buildBrewvaDeterministicCompactionSummary,
  estimateBrewvaCompactionTokens,
} from "@brewva/brewva-substrate/compaction";
import { DEFAULT_CONTEXT_STATE, type ContextState } from "@brewva/brewva-substrate/contracts";
import {
  createBrewvaHostPluginRunner,
  type CreateBrewvaHostPluginRunnerOptions,
  type BrewvaHostCommandContext,
  type BrewvaHostCustomMessage,
  type BrewvaHostCustomMessageDelivery,
  type BrewvaHostMessageVisibilityPatch,
  type BrewvaHostPluginRunner,
  type BrewvaHostToolInfo,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaSystemPrompt,
  buildBrewvaPromptText,
  cloneBrewvaPromptContentParts,
  expandBrewvaPromptTemplate,
  promptPartsArePlainText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import {
  advanceSessionPhaseResult,
  canTransitionSessionPhase,
  type BrewvaManagedPromptSession,
  type BrewvaManagedSessionStore,
  type BrewvaManagedSessionSettingsView,
  type BrewvaDiffPreferences,
  type BrewvaShellViewPreferences,
  type BrewvaModelPreferences,
  type BrewvaModelPresetSelectionRequest,
  type BrewvaModelPresetSelectionResult,
  type BrewvaModelPresetState,
  type BrewvaSteerOptions,
  type BrewvaSteerOutcome,
  type BrewvaPromptOptions,
  type BrewvaPromptQueueBehavior,
  type BrewvaQueuedPromptView,
  type BrewvaPromptSessionEvent,
  type BrewvaPromptThinkingLevel,
  type SessionPhase,
  type SessionPhaseEvent,
  type BrewvaSessionModelCatalogView,
  type BrewvaSessionModelDescriptor,
  type BrewvaSessionContext,
} from "@brewva/brewva-substrate/session";
import {
  type BrewvaCompactionRequest,
  BrewvaToolContext,
  BrewvaToolDefinition,
  BrewvaToolResult,
} from "@brewva/brewva-substrate/tools";
import {
  createBrewvaTurnLoopController,
  type BrewvaTurnLoopAfterToolCallContext,
  type BrewvaTurnLoopBeforeToolCallContext,
  type BrewvaTurnLoopController,
  type BrewvaTurnLoopEvent,
  type BrewvaTurnLoopFileContent,
  type BrewvaTurnLoopMessage,
  type BrewvaTurnLoopThinkingBudgets,
  type BrewvaTurnLoopThinkingLevel,
  type BrewvaTurnLoopTool,
  type BrewvaTurnLoopToolResultMessage,
  type BrewvaTurnLoopTransport,
} from "@brewva/brewva-substrate/turn";
import { resolveBrewvaModelSelection } from "@brewva/brewva-tools";
import {
  GoogleCachedContentManager,
  ProviderCacheBreakDetector,
  ProviderCacheStickyLatches,
  createProviderRequestFingerprint,
  createToolSchemaSnapshotStore,
  stableHash,
  stableStringify,
  type ToolSchemaSnapshot,
  type ToolSchemaSnapshotTool,
} from "../cache/index.js";
import { HOSTED_PROMPT_ATTEMPT_DISPATCH } from "../session/hosted-prompt-attempt.js";
import {
  deriveSessionPhaseFromRuntimeFactFrame,
  deriveSessionPhaseFromRuntimeFactHistory,
  type RuntimeFactSessionPhaseProjection,
} from "../session/session-phase-runtime-facts.js";
import { clearDefaultTurnLifecycleSpine } from "../session/turn-envelope.js";
import { supportsHostedExtendedThinkingModel as supportsHostedExtendedThinking } from "./hosted-provider-helpers.js";
import type { HostedSessionLogger } from "./logger.js";
import {
  cloneModelPresetState,
  DEFAULT_MODEL_PRESET_NAME,
  findModelPreset,
} from "./model-presets.js";

const DEFAULT_GOOGLE_CACHED_CONTENT_MANAGER = new GoogleCachedContentManager();

function createFallbackModelPresetState(
  activeName = DEFAULT_MODEL_PRESET_NAME,
): BrewvaModelPresetState {
  return {
    activeName,
    defaultName: DEFAULT_MODEL_PRESET_NAME,
    presets: [
      {
        name: DEFAULT_MODEL_PRESET_NAME,
        subagentModels: {},
        synthetic: true,
      },
    ],
  };
}

function resolvePresetModelSelection(
  modelText: string,
  catalog: BrewvaMutableModelCatalog,
): { model: BrewvaRegisteredModel; thinkingLevel?: BrewvaPromptThinkingLevel; modelText: string } {
  const selection = resolveBrewvaModelSelection(modelText, catalog);
  if (!selection.model) {
    throw new Error(`Model "${modelText}" was not found in the configured Brewva model registry.`);
  }
  return {
    model: selection.model,
    thinkingLevel: selection.thinkingLevel,
    modelText: selection.thinkingLevel
      ? `${selection.model.provider}/${selection.model.id}:${selection.thinkingLevel}`
      : `${selection.model.provider}/${selection.model.id}`,
  };
}

function toTurnLoopThinkingLevel(
  level: BrewvaPromptThinkingLevel | undefined,
): BrewvaTurnLoopThinkingLevel {
  switch (level) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "off":
    default:
      return "off";
  }
}

function applyMessageEndTransform(
  original: BrewvaTurnLoopMessage,
  visibility: BrewvaHostMessageVisibilityPatch,
): BrewvaTurnLoopMessage {
  return {
    ...original,
    ...(visibility.display !== undefined ? { display: visibility.display } : {}),
    ...(visibility.excludeFromContext !== undefined
      ? { excludeFromContext: visibility.excludeFromContext }
      : {}),
    ...(visibility.details !== undefined ? { details: visibility.details } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveActiveSkillSet(runtime: BrewvaRuntime, sessionId: string): string[] {
  const active = runtime.inspect.skills.getActive(sessionId) as unknown;
  if (typeof active === "string" && active.trim().length > 0) {
    return [active.trim()];
  }
  if (isRecord(active)) {
    const name = active.name;
    if (typeof name === "string" && name.trim().length > 0) {
      return [name.trim()];
    }
  }
  return [];
}

function resolveSkillRoutingEpoch(runtime: BrewvaRuntime, sessionId: string): number {
  const state = runtime.inspect.skills.getActiveState(sessionId) as unknown;
  if (isRecord(state) && typeof state.epoch === "number" && Number.isFinite(state.epoch)) {
    return Math.max(0, Math.trunc(state.epoch));
  }
  return 0;
}

function normalizePromptSource(
  source: BrewvaPromptOptions["source"] | undefined,
): string | undefined {
  if (typeof source !== "string") {
    return undefined;
  }
  const normalized = source.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildSteerAuditPayload(
  text: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chars: text.length,
    hash: stableHash(text),
    ...extra,
  };
}

function resolveChannelContext(source: string | undefined): { source: string } | "" {
  return source ? { source } : "";
}

const RECALL_CONTEXT_SOURCE_NAMES = new Set(["brewva.recall-broker"]);

interface RecallInjectionFingerprintInput {
  present: boolean;
  scope: "dynamic_tail";
  accepted: boolean;
  sourceCount: number;
  sources: string[];
  estimatedTokens: number;
  contentHash: string | null;
}

const EMPTY_RECALL_INJECTION_FINGERPRINT: RecallInjectionFingerprintInput = {
  present: false,
  scope: "dynamic_tail",
  accepted: false,
  sourceCount: 0,
  sources: [],
  estimatedTokens: 0,
  contentHash: null,
};

function isRecallContextSource(sourceName: string, budgetClasses: readonly unknown[]): boolean {
  return (
    RECALL_CONTEXT_SOURCE_NAMES.has(sourceName) ||
    sourceName.startsWith("brewva.recall.") ||
    budgetClasses.some((entry) => entry === "recall")
  );
}

function resolveRecallSourceContentHash(input: {
  source: string;
  count: number;
  estimatedTokens: number;
  contentHash: unknown;
}): string {
  if (typeof input.contentHash === "string" && input.contentHash.trim().length > 0) {
    return input.contentHash;
  }
  return stableHash(
    stableStringify({
      source: input.source,
      count: input.count,
      estimatedTokens: input.estimatedTokens,
    }),
  );
}

function resolveRecallInjectionFingerprint(
  messages: readonly BrewvaHostCustomMessage[] | undefined,
): RecallInjectionFingerprintInput {
  const recallSources: Array<{
    source: string;
    count: number;
    estimatedTokens: number;
    contentHash: string;
  }> = [];
  let accepted = false;
  for (const message of messages ?? []) {
    if (message.customType !== "brewva-context-injection") {
      continue;
    }
    const contextSources = isRecord(message.details) ? message.details.contextSources : undefined;
    if (!isRecord(contextSources)) {
      continue;
    }
    accepted = accepted || contextSources.accepted === true;
    const sources = Array.isArray(contextSources.sources) ? contextSources.sources : [];
    for (const source of sources) {
      if (!isRecord(source)) {
        continue;
      }
      const sourceName = typeof source.source === "string" ? source.source : "";
      const budgetClasses = Array.isArray(source.budgetClasses) ? source.budgetClasses : [];
      if (!isRecallContextSource(sourceName, budgetClasses)) {
        continue;
      }
      const count = typeof source.count === "number" ? Math.max(0, Math.trunc(source.count)) : 0;
      const estimatedTokens =
        typeof source.estimatedTokens === "number"
          ? Math.max(0, Math.trunc(source.estimatedTokens))
          : 0;
      recallSources.push({
        source: sourceName,
        count,
        estimatedTokens,
        contentHash: resolveRecallSourceContentHash({
          source: sourceName,
          count,
          estimatedTokens,
          contentHash: source.contentHash,
        }),
      });
    }
  }
  if (recallSources.length === 0) {
    return { ...EMPTY_RECALL_INJECTION_FINGERPRINT };
  }
  return {
    present: true,
    scope: "dynamic_tail",
    accepted,
    sourceCount: recallSources.length,
    sources: recallSources.map((entry) => entry.source).toSorted(),
    estimatedTokens: recallSources.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
    contentHash: stableHash(stableStringify(recallSources)),
  };
}

export const MANAGED_AGENT_SESSION_TEST_ONLY = {
  resolveRecallInjectionFingerprint,
  isCachedContentUnsupportedStreamError,
} as const;

interface QueuedPromptEntry {
  view: BrewvaQueuedPromptView;
  message: QueuedUserMessage;
}

type QueuedUserMessage = Extract<BrewvaTurnLoopMessage, { role: "user" }>;

function buildProviderDynamicTailSummary(input: {
  payload: unknown;
  channelContext: unknown;
  recallInjection: RecallInjectionFingerprintInput;
  visibleHistoryReduction: unknown;
}): unknown {
  return {
    version: 1,
    payloadTail: summarizeProviderPayloadTail(input.payload),
    channelContext: input.channelContext,
    recallInjection: input.recallInjection,
    visibleHistoryReduction: input.visibleHistoryReduction,
  };
}

function summarizeProviderPayloadTail(payload: unknown): unknown {
  if (!isRecord(payload)) {
    const serialized = stableStringify(payload);
    return {
      kind: typeof payload,
      bytes: serialized.length,
      tailHash: stableHash(serialized.slice(-4096)),
    };
  }
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  return {
    messageCount: messages.length,
    lastMessages: messages.slice(-4).map((message) => summarizeProviderPayloadMessage(message)),
    hasTools: Array.isArray(payload.tools) && payload.tools.length > 0,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
  };
}

function summarizeProviderPayloadMessage(message: unknown): unknown {
  const serialized = stableStringify(message);
  const role = isRecord(message) && typeof message.role === "string" ? message.role : null;
  const type = isRecord(message) && typeof message.type === "string" ? message.type : null;
  const content = isRecord(message) ? message.content : undefined;
  const contentSerialized = stableStringify(content ?? null);
  return {
    role,
    type,
    bytes: serialized.length,
    contentBytes: contentSerialized.length,
    contentTailHash: stableHash(contentSerialized.slice(-4096)),
  };
}

function resolveExpectedProviderCacheBreak(
  runtime: BrewvaRuntime,
  sessionId: string,
): ExpectedProviderCacheBreak | undefined {
  const transientReduction = runtime.inspect.context.getTransientReduction(sessionId);
  if (!transientReduction?.expectedCacheBreak || !transientReduction.classification) {
    return undefined;
  }
  if (transientReduction.classification === "cacheCold") {
    return undefined;
  }
  return {
    classification: transientReduction.classification,
    reason: transientReduction.reason ?? "expected_provider_cache_break",
  };
}

function resolveProviderCacheDiagnosticDumpDirectory(cwd: string): string | undefined {
  const explicit =
    process.env.BREWVA_CACHE_BREAK_DUMP_DIR?.trim() ||
    process.env.BREWVA_PROVIDER_CACHE_DEBUG_DIR?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  return process.env.BREWVA_PROVIDER_CACHE_DEBUG_DUMP === "1"
    ? join(cwd, ".brewva", "diagnostics", "provider-cache")
    : undefined;
}

interface ProviderCacheModelIdentity {
  provider: string;
  api: Api;
  id: string;
  baseUrl?: string;
}

function buildProviderCacheModelKey(model: ProviderCacheModelIdentity): string {
  return `${model.provider}\0${model.api}\0${model.id}`;
}

function buildUnsupportedProviderCacheRender(input: {
  model: ProviderCacheModelIdentity;
  transport: BrewvaTurnLoopTransport;
  sessionId: string;
  cachePolicy: ProviderCachePolicy;
}): ProviderCacheRenderState {
  const capability = resolveProviderCacheCapability({
    api: input.model.api,
    provider: input.model.provider,
    modelId: input.model.id,
    baseUrl: input.model.baseUrl,
    transport: input.transport,
  });
  const observableWithoutRenderedPolicy = capability.cacheCounters !== "none";
  return {
    status:
      input.cachePolicy.retention === "none"
        ? "disabled"
        : observableWithoutRenderedPolicy
          ? "degraded"
          : "unsupported",
    reason:
      input.cachePolicy.retention === "none"
        ? "cache_policy_disabled"
        : observableWithoutRenderedPolicy
          ? capability.reason
          : "provider_cache_observability_unavailable",
    renderedRetention: "none",
    bucketKey: buildProviderCacheBucketKey({
      provider: input.model.provider,
      api: input.model.api,
      model: input.model.id,
      sessionId: input.sessionId,
      policy: input.cachePolicy,
    }),
    capability,
  };
}

function normalizeProviderCacheRender(input: {
  metadata?: ProviderPayloadMetadata;
  model: ProviderCacheModelIdentity;
  transport: BrewvaTurnLoopTransport;
  sessionId: string;
  cachePolicy: ProviderCachePolicy;
  previousRender?: ProviderCacheRenderState;
  previousRenderModelKey?: string;
}): ProviderCacheRenderState {
  const metadataRender = input.metadata?.cacheRender;
  if (metadataRender) {
    return {
      status: metadataRender.status,
      reason: metadataRender.reason,
      renderedRetention: metadataRender.renderedRetention,
      bucketKey: metadataRender.bucketKey,
      capability: metadataRender.capability ?? input.metadata?.cacheCapability,
      cachedContentName: metadataRender.cachedContentName,
      cachedContentTtlSeconds: metadataRender.cachedContentTtlSeconds,
    };
  }
  if (
    input.previousRenderModelKey === buildProviderCacheModelKey(input.model) &&
    input.previousRender
  ) {
    return input.previousRender;
  }
  return buildUnsupportedProviderCacheRender(input);
}

function providerCacheCountersAvailable(render: ProviderCacheRenderState): boolean {
  if (render.capability?.cacheCounters === "none") {
    return false;
  }
  return render.status === "rendered" || render.status === "degraded";
}

function isCachedContentUnsupportedStreamError(message: string): boolean {
  if (!/\bcached(?:_|\s*)content\b/i.test(message)) {
    return false;
  }
  return /\b(?:not\s+supported|unsupported|unknown\s+(?:field|name)|unrecognized\s+field|unexpected\s+field|cannot\s+find\s+field|ignored)\b/i.test(
    message,
  );
}

export interface BrewvaManagedAgentSessionSettingsPort {
  getQuietStartup(): boolean;
  getQueueMode(): "all" | "one-at-a-time" | undefined;
  getFollowUpMode(): "all" | "one-at-a-time" | undefined;
  getTransport(): BrewvaTurnLoopTransport;
  getCachePolicy(): ProviderCachePolicy;
  getThinkingBudgets(): BrewvaTurnLoopThinkingBudgets | undefined;
  getRetrySettings(): { maxDelayMs: number } | undefined;
  getModelPresetState?(): BrewvaModelPresetState;
  setDefaultThinkingLevel(thinkingLevel: string): void;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export interface CreateBrewvaManagedAgentSessionOptions {
  cwd: string;
  agentDir: string;
  sessionStore: ManagedAgentSessionStore;
  settings: BrewvaManagedAgentSessionSettingsPort;
  runtime?: BrewvaRuntime;
  modelCatalog: BrewvaMutableModelCatalog;
  resourceLoader: BrewvaHostedResourceLoader;
  runtimePlugins?: CreateBrewvaHostPluginRunnerOptions["plugins"];
  customTools?: readonly BrewvaToolDefinition[];
  initialModel?: BrewvaRegisteredModel;
  initialThinkingLevel?: BrewvaPromptThinkingLevel;
  initialModelPresetState?: BrewvaModelPresetState;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
  googleCachedContentManager?: GoogleCachedContentManager;
}

type PendingQueuedItem =
  | {
      kind: "user";
      parts: BrewvaPromptContentPart[];
    }
  | { kind: "custom"; message: BrewvaHostCustomMessage };

type ManagedAgentSessionStoreCore = Pick<
  BrewvaManagedSessionStore,
  | "getSessionId"
  | "getLeafId"
  | "getBranch"
  | "buildSessionContext"
  | "appendThinkingLevelChange"
  | "appendModelChange"
  | "appendModelPresetSelection"
  | "appendMessage"
  | "appendCustomMessageEntry"
  | "appendCompaction"
  | "appendBranchSummaryEntry"
  | "branchWithSummary"
>;

export interface ManagedAgentSessionStore extends ManagedAgentSessionStoreCore {
  hasSessionEntryType?(type: string): boolean;
  subscribeSessionWire?(listener: (frame: SessionWireFrame) => void): () => void;
  querySessionWire?(): SessionWireFrame[];
  dispose?(): void;
  readContextState?(): ContextState;
  readLifecycle?(): SessionLifecycleSnapshot | undefined;
  previewCompaction(
    summary: string,
    tokensBefore: number,
    compactId?: string,
    sourceLeafEntryId?: string | null,
  ): {
    compactId: string;
    sourceLeafEntryId: string | null;
    firstKeptEntryId: string;
    context: BrewvaSessionContext;
    tokensBefore: number;
    summary: string;
  };
}

const NOOP_UI: BrewvaToolUiPort = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
  notify() {},
  onTerminalInput() {
    return () => undefined;
  },
  setStatus() {},
  setWorkingMessage() {},
  setHiddenThinkingLabel() {},
  async custom() {
    return undefined as never;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() {
    return "";
  },
  async editor() {
    return undefined;
  },
  setEditorComponent() {},
  theme: {},
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: false, error: "UI unavailable" };
  },
  getToolsExpanded() {
    return true;
  },
  setToolsExpanded() {},
};

function toAgentTool(
  tool: BrewvaToolDefinition,
  ctxFactory: () => BrewvaToolContext,
  schemaOverride?: ToolSchemaSnapshotTool,
): BrewvaTurnLoopTool {
  return {
    name: tool.name,
    label: tool.label,
    description: schemaOverride?.description ?? tool.description,
    parameters: (schemaOverride?.parameters ?? tool.parameters) as BrewvaTurnLoopTool["parameters"],
    prepareArguments: tool.prepareArguments,
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: ToolResultForAgent) => void,
    ) =>
      tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate ? (update) => onUpdate(update as unknown as ToolResultForAgent) : undefined,
        ctxFactory(),
      ) as Promise<ToolResultForAgent>,
  };
}

type ToolResultForAgent = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: unknown;
};

interface PendingCompactionRequestState {
  customInstructions?: string;
  onComplete?: BrewvaCompactionRequest["onComplete"];
  onError?: BrewvaCompactionRequest["onError"];
}

const REQUIRED_HOSTED_PERSISTENCE_EVENTS = ["message_end", "session_compact"] as const;
const PROMPT_FILE_MAX_BYTES = 50 * 1024;
const PROMPT_BINARY_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const PROMPT_DIRECTORY_ENTRY_LIMIT = 64;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  ...IMAGE_MIME_BY_EXTENSION,
  ".pdf": "application/pdf",
};

function sameSessionMessages(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function inferRecoveryCrashPoint(
  current: SessionPhase,
): "model_streaming" | "tool_executing" | "wal_append" {
  switch (current.kind) {
    case "model_streaming":
      return "model_streaming";
    case "tool_executing":
    case "waiting_approval":
      return "tool_executing";
    default:
      return "wal_append";
  }
}

function deriveSessionPhaseFromLifecycleSnapshot(
  snapshot: SessionLifecycleSnapshot,
  fallbackTurn: number,
): RuntimeFactSessionPhaseProjection | null {
  const resolvedTurn = fallbackTurn > 0 ? fallbackTurn : 1;
  switch (snapshot.execution.kind) {
    case "idle":
      return {
        phase: { kind: "idle" },
      };
    case "tool_executing": {
      const toolCallId = snapshot.execution.toolCallId;
      const toolName = snapshot.execution.toolName;
      const toolExecutionTurn =
        snapshot.tooling.openToolCalls.find((record) => record.toolCallId === toolCallId)?.turn ??
        resolvedTurn;
      return {
        phase: {
          kind: "tool_executing",
          toolCallId,
          toolName,
          turn: toolExecutionTurn,
        },
      };
    }
    case "waiting_approval": {
      if (!snapshot.execution.toolCallId || !snapshot.execution.toolName) {
        return null;
      }
      return {
        phase: {
          kind: "waiting_approval",
          requestId:
            snapshot.execution.requestId ?? `transition:${snapshot.execution.reason ?? "approval"}`,
          toolCallId: snapshot.execution.toolCallId,
          toolName: snapshot.execution.toolName,
          turn: resolvedTurn,
        },
        reason: snapshot.execution.reason ?? undefined,
        detail: snapshot.execution.detail ?? undefined,
      };
    }
    case "recovering":
      return {
        phase: {
          kind: "recovering",
          recoveryAnchor: snapshot.execution.reason
            ? `transition:${snapshot.execution.reason}`
            : undefined,
          turn: resolvedTurn,
        },
        reason: snapshot.execution.reason ?? undefined,
        detail: snapshot.execution.detail ?? undefined,
      };
    case "terminated":
      return {
        phase: {
          kind: "terminated",
          reason: "host_closed",
        },
        reason: snapshot.execution.reason ?? undefined,
      };
    default:
      return null;
  }
}

function parseCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) {
    return null;
  }
  const spaceIndex = text.indexOf(" ");
  return {
    name: spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1),
  };
}

function buildTextPromptParts(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
}

function toAgentUserContent(
  parts: readonly BrewvaPromptContentPart[],
): Extract<BrewvaTurnLoopMessage, { role: "user" }>["content"] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      };
    }
    return {
      type: "file",
      uri: part.uri,
      name: part.name,
      mimeType: part.mimeType,
      displayText: part.displayText,
    };
  });
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 7 || (byte > 13 && byte < 32)) {
      suspicious += 1;
    }
  }
  return suspicious <= Math.max(2, Math.floor(sample.length * 0.02));
}

function truncatePromptFileText(text: string): string {
  const lines = text.split("\n");
  let usedBytes = 0;
  const output: string[] = [];
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length >= 2000 || usedBytes + lineBytes > PROMPT_FILE_MAX_BYTES) {
      break;
    }
    output.push(line);
    usedBytes += lineBytes;
  }
  const content = output.join("\n");
  if (content.length === text.length) {
    return content;
  }
  return `${content}\n\n[truncated to ${PROMPT_FILE_MAX_BYTES} bytes / 2000 lines]`;
}

function resolvePromptFilePart(
  cwd: string,
  part: BrewvaTurnLoopFileContent,
):
  | {
      kind: "text";
      uri: string;
      text: string;
      name?: string;
      mimeType?: string;
    }
  | {
      kind: "image";
      uri: string;
      data: string;
      mimeType: string;
      name?: string;
    }
  | {
      kind: "binary";
      uri: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      summary?: string;
      dataBase64?: string;
    }
  | {
      kind: "directory";
      uri: string;
      name?: string;
      entries?: string[];
      summary?: string;
    }
  | undefined {
  let absolutePath: string;
  try {
    if (part.uri.startsWith("file://")) {
      absolutePath = new URL(part.uri).pathname;
    } else if (part.uri.startsWith("/")) {
      absolutePath = part.uri;
    } else {
      absolutePath = resolve(cwd, part.uri);
    }
  } catch {
    return undefined;
  }

  try {
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      return {
        kind: "directory",
        uri: part.uri,
        name: part.name ?? basename(absolutePath),
        entries: readdirSync(absolutePath).slice(0, PROMPT_DIRECTORY_ENTRY_LIMIT),
        summary: "Directory reference",
      };
    }

    const fileName = part.name ?? basename(absolutePath);
    const mimeType = part.mimeType ?? FILE_MIME_BY_EXTENSION[extname(absolutePath).toLowerCase()];
    if (mimeType && mimeType.startsWith("image/")) {
      return {
        kind: "image",
        uri: part.uri,
        data: readFileSync(absolutePath).toString("base64"),
        mimeType,
        name: fileName,
      };
    }

    const buffer = readFileSync(absolutePath);
    if (!isProbablyTextBuffer(buffer)) {
      return {
        kind: "binary",
        uri: part.uri,
        name: fileName,
        mimeType,
        sizeBytes: stats.size,
        summary:
          stats.size > PROMPT_BINARY_INLINE_MAX_BYTES
            ? `Binary file reference (raw bytes omitted; exceeds ${PROMPT_BINARY_INLINE_MAX_BYTES} bytes)`
            : "Binary file reference",
        dataBase64:
          stats.size <= PROMPT_BINARY_INLINE_MAX_BYTES ? buffer.toString("base64") : undefined,
      };
    }

    return {
      kind: "text",
      uri: part.uri,
      text: truncatePromptFileText(buffer.toString("utf8")),
      name: fileName,
      mimeType,
    };
  } catch {
    return undefined;
  }
}

function buildSkillCommandText(text: string, resourceLoader: BrewvaHostedResourceLoader): string {
  if (!text.startsWith("/skill:")) {
    return text;
  }
  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const rawArgs = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = resourceLoader.getSkills().skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    return text;
  }

  try {
    const content = readFileSync(skill.filePath, "utf8");
    const body = content.replace(/^---[\s\S]*?---\n?/u, "").trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return rawArgs.length > 0 ? `${skillBlock}\n\n${rawArgs}` : skillBlock;
  } catch {
    return text;
  }
}

class ManagedSessionSettingsView implements BrewvaManagedSessionSettingsView {
  constructor(private readonly settings: BrewvaManagedAgentSessionSettingsPort) {}

  getQuietStartup(): boolean {
    return this.settings.getQuietStartup();
  }

  getModelPreferences(): BrewvaModelPreferences {
    return this.settings.getModelPreferences();
  }

  setModelPreferences(preferences: BrewvaModelPreferences): void {
    this.settings.setModelPreferences(preferences);
  }

  getDiffPreferences(): BrewvaDiffPreferences {
    return this.settings.getDiffPreferences();
  }

  setDiffPreferences(preferences: BrewvaDiffPreferences): void {
    this.settings.setDiffPreferences(preferences);
  }

  getShellViewPreferences(): BrewvaShellViewPreferences {
    return this.settings.getShellViewPreferences();
  }

  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void {
    this.settings.setShellViewPreferences(preferences);
  }
}

class ManagedSessionModelCatalogView implements BrewvaSessionModelCatalogView {
  constructor(private readonly catalog: BrewvaMutableModelCatalog) {}

  getAvailable(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAvailable() as readonly BrewvaSessionModelDescriptor[];
  }

  getAll(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAll();
  }
}

class BrewvaManagedAgentSession implements BrewvaManagedPromptSession {
  readonly sessionManager: ManagedAgentSessionStore;
  readonly settingsManager: BrewvaManagedSessionSettingsView;
  readonly modelRegistry: BrewvaSessionModelCatalogView;

  readonly #cwd: string;
  readonly #runtime: BrewvaRuntime | undefined;
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #catalog: BrewvaMutableModelCatalog;
  #modelPresetState: BrewvaModelPresetState;
  readonly #resourceLoader: BrewvaHostedResourceLoader;
  readonly #agent: BrewvaTurnLoopController;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #registeredTools: BrewvaToolDefinition[];
  readonly #toolDefinitions = new Map<string, BrewvaToolDefinition>();
  readonly #toolPromptSnippets = new Map<string, string>();
  readonly #toolPromptGuidelines = new Map<string, string[]>();
  readonly #toolSchemaSnapshotStore = createToolSchemaSnapshotStore();
  readonly #providerCacheStickyLatches = new ProviderCacheStickyLatches();
  readonly #listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
  #ui: BrewvaToolUiPort;
  readonly #queuedPrompts: QueuedPromptEntry[] = [];
  readonly #queuedPromptIdsByMessage = new WeakMap<QueuedUserMessage, string>();
  readonly #pendingNextTurnMessages: Array<Extract<BrewvaTurnLoopMessage, { role: "custom" }>> = [];
  readonly #commandUnsupported = async (): Promise<{ cancelled: boolean }> => ({ cancelled: true });
  #sessionPhase: SessionPhase = { kind: "idle" };
  #unsubscribeSessionWire: (() => void) | null = null;
  #baseSystemPrompt = "";
  #disposed = false;
  #isCompacting = false;
  #commandDispatchBuffer: PendingQueuedItem[] | null = null;
  #pendingCompactionRequest: PendingCompactionRequestState | null = null;
  #stopAfterCurrentToolResults = false;
  #turnIndex = 0;
  #turnStartTimestamp = 0;
  #contextState: ContextState = { ...DEFAULT_CONTEXT_STATE };
  #activePromptSource: string | undefined;
  #lastRecallInjectionFingerprint: RecallInjectionFingerprintInput = {
    ...EMPTY_RECALL_INJECTION_FINGERPRINT,
  };
  readonly #logger: HostedSessionLogger | null;
  readonly #onProviderAssistantMessage:
    | ((message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>) => void)
    | undefined;
  readonly #onDispose: (() => void) | undefined;
  #providerCacheSessionClear: Promise<void> | null = null;

  constructor(input: {
    cwd: string;
    runtime?: BrewvaRuntime;
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    resourceLoader: BrewvaHostedResourceLoader;
    sessionStore: ManagedAgentSessionStore;
    modelPresetState?: BrewvaModelPresetState;
    customTools: readonly BrewvaToolDefinition[];
    runner: BrewvaHostPluginRunner;
    agent: BrewvaTurnLoopController;
    ui?: BrewvaToolUiPort;
    logger?: HostedSessionLogger;
    onProviderAssistantMessage?: (
      message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>,
    ) => void;
    onDispose?: () => void;
  }) {
    this.#cwd = input.cwd;
    this.#runtime = input.runtime;
    this.#settings = input.settings;
    this.#catalog = input.catalog;
    this.#modelPresetState = cloneModelPresetState(
      input.modelPresetState ??
        input.settings.getModelPresetState?.() ??
        createFallbackModelPresetState(
          input.sessionStore.buildSessionContext().activeModelPresetName,
        ),
    );
    this.#resourceLoader = input.resourceLoader;
    this.#ui = input.ui ?? NOOP_UI;
    this.sessionManager = input.sessionStore;
    this.settingsManager = new ManagedSessionSettingsView(input.settings);
    this.modelRegistry = new ManagedSessionModelCatalogView(input.catalog);
    this.#registeredTools = [...input.customTools];
    this.#runner = input.runner;
    this.#agent = input.agent;
    this.#logger = input.logger ?? null;
    this.#onProviderAssistantMessage = input.onProviderAssistantMessage;
    this.#onDispose = input.onDispose;
  }

  static async create(
    options: CreateBrewvaManagedAgentSessionOptions,
  ): Promise<BrewvaManagedAgentSession> {
    const toolDefinitions = [...(options.customTools ?? [])];
    let session: BrewvaManagedAgentSession | undefined;

    const runner = await createBrewvaHostPluginRunner({
      plugins: options.runtimePlugins,
      actions: {
        sendMessage(message, sendOptions) {
          if (!session) {
            throw new Error("Session not initialized");
          }
          void session.sendCustomMessage(message, sendOptions);
        },
        sendUserMessage(content, sendOptions) {
          if (!session) {
            throw new Error("Session not initialized");
          }
          void session.sendUserMessage(content, sendOptions);
        },
        getActiveTools() {
          return session?.getActiveToolNames() ?? [];
        },
        getAllTools() {
          return session?.getAllToolInfo() ?? [];
        },
        setActiveTools(toolNames) {
          session?.setActiveTools(toolNames);
        },
        refreshTools() {
          session?.refreshTools();
        },
      },
      registrations: {
        registerTool(tool) {
          const existingIndex = toolDefinitions.findIndex(
            (candidate) => candidate.name === tool.name,
          );
          if (existingIndex >= 0) {
            toolDefinitions[existingIndex] = tool;
          } else {
            toolDefinitions.push(tool);
          }
          session?.registerRuntimePluginTool(tool);
        },
      },
    });
    const missingPersistenceEvents =
      options.sessionStore.subscribeSessionWire || options.sessionStore.querySessionWire
        ? REQUIRED_HOSTED_PERSISTENCE_EVENTS.filter((event) => !runner.hasHandlers(event))
        : [];
    if (missingPersistenceEvents.length > 0) {
      throw new Error(
        `Hosted runtime-backed sessions require persistence handlers for ${missingPersistenceEvents.join(
          ", ",
        )}. Add createHostedTurnPipeline(...).`,
      );
    }

    let lastProviderFingerprint: ProviderRequestFingerprint | undefined;
    let lastCacheRender: ProviderCacheRenderState | undefined;
    let lastCacheRenderModelKey: string | undefined;
    let lastGoogleCredential: string | undefined;
    let lastGoogleModelBaseUrl: string | undefined;
    const cacheBreakDetector = new ProviderCacheBreakDetector({
      diagnosticDumpDirectory: resolveProviderCacheDiagnosticDumpDirectory(options.cwd),
    });
    const googleCachedContentManager =
      options.googleCachedContentManager ?? DEFAULT_GOOGLE_CACHED_CONTENT_MANAGER;
    const sessionId = options.sessionStore.getSessionId();
    const releaseGoogleCachedContent = () => {
      // Best-effort cleanup uses the latest Google credential. If the user rotates accounts mid-session,
      // delete may fail and fall back to the manager's pending-delete retry policy.
      void googleCachedContentManager
        .releaseSession(options.cwd, sessionId, lastGoogleCredential)
        .catch(() => undefined);
    };
    const clearCacheState = options.runtime?.maintain.session.onClearState((clearedSessionId) => {
      if (clearedSessionId === sessionId) {
        cacheBreakDetector.clear();
        lastProviderFingerprint = undefined;
        lastCacheRender = undefined;
        lastCacheRenderModelKey = undefined;
        googleCachedContentManager.resetCapability(options.cwd, lastGoogleModelBaseUrl);
        lastGoogleModelBaseUrl = undefined;
        releaseGoogleCachedContent();
        session?.clearProviderCacheSessionStateBestEffort();
      }
    });

    const agent = createBrewvaTurnLoopController({
      initialModel: options.initialModel,
      initialThinkingLevel: toTurnLoopThinkingLevel(options.initialThinkingLevel),
      queueMode: options.settings.getQueueMode(),
      followUpMode: options.settings.getFollowUpMode(),
      transport: options.settings.getTransport(),
      cachePolicy: options.settings.getCachePolicy(),
      thinkingBudgets: options.settings.getThinkingBudgets(),
      maxRetryDelayMs: options.settings.getRetrySettings()?.maxDelayMs,
      sessionId,
      resolveRequestAuth: async (model) => options.modelCatalog.getApiKeyAndHeaders(model),
      beforeToolCall: async (input: BrewvaTurnLoopBeforeToolCallContext) => {
        if (!session) {
          return undefined;
        }
        const result = await runner.emitToolCall(
          {
            type: "tool_call",
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.name,
            input: input.args as Record<string, unknown>,
          },
          session.createHostContext(),
        );
        return result ? { block: result.block, reason: result.reason } : undefined;
      },
      afterToolCall: async (input: BrewvaTurnLoopAfterToolCallContext) => {
        if (!session) {
          return undefined;
        }
        const result = await runner.emitToolResult(
          {
            type: "tool_result",
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.name,
            input: input.args as Record<string, unknown>,
            content: input.result.content as BrewvaToolResult["content"],
            details: input.result.details,
            isError: input.isError,
          },
          session.createHostContext(),
        );
        if (!result) {
          return undefined;
        }
        return {
          content: result.content as ToolResultForAgent["content"],
          details: result.details,
          isError: result.isError,
        };
      },
      onPayload: async (payload, model, metadata) => {
        if (!session) {
          return payload;
        }
        let nextPayload = await runner.emitBeforeProviderRequest(
          {
            type: "before_provider_request",
            payload,
            provider: model.provider,
            api: model.api,
            modelId: model.id,
          },
          session.createHostContext(),
        );
        if (options.runtime) {
          const channelContext = session.resolveProviderCacheChannelContext();
          const cachePolicy = options.settings.getCachePolicy();
          let cacheRender = normalizeProviderCacheRender({
            metadata,
            model,
            transport: options.settings.getTransport(),
            sessionId,
            cachePolicy,
            previousRender: lastCacheRender,
            previousRenderModelKey: lastCacheRenderModelKey,
          });
          if (model.api === "google-gemini-cli") {
            const auth = await options.modelCatalog.getApiKeyAndHeaders(model);
            lastGoogleCredential = auth.ok ? auth.apiKey : undefined;
            lastGoogleModelBaseUrl = model.baseUrl;
            const googleCache = await googleCachedContentManager.apply({
              workspaceRoot: options.cwd,
              sessionId,
              cachePolicy,
              credential: auth.ok ? auth.apiKey : undefined,
              payload: nextPayload,
              modelBaseUrl: model.baseUrl,
            });
            nextPayload = googleCache.payload;
            if (googleCache.render) {
              cacheRender = {
                status: googleCache.render.status,
                reason: googleCache.render.reason,
                renderedRetention: googleCache.render.renderedRetention,
                bucketKey: googleCache.render.bucketKey,
                capability: googleCache.render.capability,
                cachedContentName: googleCache.render.cachedContentName,
                cachedContentTtlSeconds: googleCache.render.cachedContentTtlSeconds,
              };
            }
          }
          lastCacheRender = cacheRender;
          lastCacheRenderModelKey = buildProviderCacheModelKey(model);
          const toolSchemaSnapshot = session.resolveProviderToolSchemaSnapshot("provider_payload");
          const stickyLatches = session.observeProviderCacheStickyLatches({
            cachePolicy,
            cacheRender,
            transport: options.settings.getTransport(),
            reasoning: metadata?.reasoning ?? agent.state.thinkingLevel,
            channelContext,
          });
          const transientReduction =
            options.runtime.inspect.context.getTransientReduction(sessionId);
          const visibleHistoryReduction = {
            epoch: options.runtime.inspect.context.getVisibleReadEpoch(sessionId),
            transientReductionStatus: transientReduction?.status ?? "none",
            transientReductionClassification: transientReduction?.classification ?? null,
            expectedCacheBreak: transientReduction?.expectedCacheBreak ?? false,
          };
          const recallInjection = session.#lastRecallInjectionFingerprint;
          lastProviderFingerprint = createProviderRequestFingerprint({
            provider: model.provider,
            api: model.api,
            model: model.id,
            transport: options.settings.getTransport(),
            sessionId,
            cachePolicy,
            toolSchemaSnapshot,
            stablePrefixParts: [agent.state.systemPrompt],
            dynamicTailParts: [
              buildProviderDynamicTailSummary({
                payload: nextPayload,
                channelContext,
                recallInjection,
                visibleHistoryReduction,
              }),
            ],
            activeSkillSet: resolveActiveSkillSet(options.runtime, sessionId),
            skillRoutingEpoch: resolveSkillRoutingEpoch(options.runtime, sessionId),
            channelContext,
            renderedCache: cacheRender,
            stickyLatches,
            reasoning: metadata?.reasoning ?? agent.state.thinkingLevel,
            thinkingBudgets: metadata?.thinkingBudgets ?? options.settings.getThinkingBudgets(),
            cacheRelevantHeaders: metadata?.headers,
            extraBody: metadata?.extraBody,
            visibleHistoryReduction,
            recallInjection,
            providerFallback: metadata?.providerFallback ?? { active: false },
            payload: nextPayload,
          });
        }
        return nextPayload;
      },
      onCacheRender: (render, model) => {
        lastCacheRender = {
          status: render.status,
          reason: render.reason,
          renderedRetention: render.renderedRetention,
          bucketKey: render.bucketKey,
          capability: render.capability,
          cachedContentName: render.cachedContentName,
          cachedContentTtlSeconds: render.cachedContentTtlSeconds,
        };
        lastCacheRenderModelKey = buildProviderCacheModelKey(model);
      },
      transformContext: async (messages) => {
        if (!session) {
          return messages;
        }
        return runner.emitContext(
          { type: "context", messages },
          session.createHostContext(),
        ) as Promise<BrewvaTurnLoopMessage[]>;
      },
      resolveFile: (part) => resolvePromptFilePart(options.cwd, part),
      shouldStopAfterToolResults: (toolResults) =>
        session?.consumeToolResultStop(toolResults) ?? false,
    });

    session = new BrewvaManagedAgentSession({
      cwd: options.cwd,
      settings: options.settings,
      catalog: options.modelCatalog,
      resourceLoader: options.resourceLoader,
      sessionStore: options.sessionStore,
      modelPresetState: options.initialModelPresetState,
      customTools: toolDefinitions,
      runner,
      agent,
      ui: options.ui,
      runtime: options.runtime,
      logger: options.logger,
      onProviderAssistantMessage: (message) => {
        if (!options.runtime || !lastProviderFingerprint || !lastCacheRender) {
          return;
        }
        if (message.api === "google-gemini-cli") {
          if (
            message.stopReason === "error" &&
            typeof message.errorMessage === "string" &&
            isCachedContentUnsupportedStreamError(message.errorMessage)
          ) {
            googleCachedContentManager.markUnsupportedFromStreamError({
              workspaceRoot: options.cwd,
              modelBaseUrl: lastGoogleModelBaseUrl,
              reason: message.errorMessage,
            });
          } else {
            googleCachedContentManager.observeUsage({
              workspaceRoot: options.cwd,
              modelBaseUrl: lastGoogleModelBaseUrl,
              render: lastCacheRender,
              cacheRead: message.usage.cacheRead,
            });
          }
        }
        const expectedBreak = resolveExpectedProviderCacheBreak(options.runtime, sessionId);
        const breakObservation = cacheBreakDetector.observe({
          source: lastProviderFingerprint.bucketKey,
          fingerprint: lastProviderFingerprint,
          render: lastCacheRender,
          usage: {
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
          },
          expectedBreak,
          observability: {
            cacheCountersAvailable: providerCacheCountersAvailable(lastCacheRender),
            reason: providerCacheCountersAvailable(lastCacheRender)
              ? undefined
              : lastCacheRender.reason,
          },
          observedAt: Date.now(),
        });
        options.runtime.maintain.context.observeProviderCache(sessionId, {
          source: lastProviderFingerprint.bucketKey,
          fingerprint: lastProviderFingerprint,
          render: lastCacheRender,
          breakObservation,
        });
      },
      onDispose: () => {
        releaseGoogleCachedContent();
        clearCacheState?.();
      },
    });
    await session.initialize();
    await session.emitSessionStart();
    return session;
  }

  async initialize(): Promise<void> {
    this.refreshTools();
    const restoredMessages = this.sessionManager.buildSessionContext().messages;
    if (restoredMessages.length > 0) {
      await this.replaceMessages(restoredMessages);
    }
    const lifecycleSnapshot = this.sessionManager.readLifecycle?.();
    const lifecycleProjection = lifecycleSnapshot
      ? deriveSessionPhaseFromLifecycleSnapshot(lifecycleSnapshot, this.resolvePhaseTurn())
      : null;
    if (lifecycleProjection) {
      await this.reconcileSessionPhase(lifecycleProjection.phase);
    } else {
      const runtimeFactHistory = this.sessionManager.querySessionWire?.();
      if (runtimeFactHistory && runtimeFactHistory.length > 0) {
        await this.reconcileSessionPhase(
          deriveSessionPhaseFromRuntimeFactHistory(
            this.sessionManager.getSessionId(),
            runtimeFactHistory,
          ).phase,
        );
      }
    }
    this.#agent.subscribe((event) => this.handleAgentEvent(event));
    this.#unsubscribeSessionWire =
      this.sessionManager.subscribeSessionWire?.((frame) => {
        void this.advanceSessionPhaseFromRuntimeFactFrame(frame);
      }) ?? null;
    await this.syncContextState();
  }

  get model(): BrewvaSessionModelDescriptor | undefined {
    const model = this.#agent.state.model;
    return model ? this.#catalog.find(model.provider, model.id) : undefined;
  }

  get thinkingLevel(): BrewvaPromptThinkingLevel {
    return this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
  }

  get isStreaming(): boolean {
    return this.#agent.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this.#isCompacting;
  }

  getModelPresetState(): BrewvaModelPresetState {
    return cloneModelPresetState(this.#modelPresetState);
  }

  queueModelPresetForNextTurn(name: string): BrewvaModelPresetSelectionResult {
    const preset = findModelPreset(this.#modelPresetState, name);
    if (!preset) {
      throw new Error(`Unknown model preset: ${name}`);
    }
    this.#modelPresetState = {
      ...this.#modelPresetState,
      pendingName: preset.name,
    };
    return {
      selectedName: preset.name,
      previousName: this.#modelPresetState.activeName,
      modelChanged: false,
      queued: true,
      effectiveMainModel: preset.mainModel,
    };
  }

  async selectModelPreset(
    request: BrewvaModelPresetSelectionRequest,
  ): Promise<BrewvaModelPresetSelectionResult> {
    const preset = findModelPreset(this.#modelPresetState, request.name);
    if (!preset) {
      throw new Error(`Unknown model preset: ${request.name}`);
    }
    const selection = preset.mainModel
      ? resolvePresetModelSelection(preset.mainModel, this.#catalog)
      : undefined;
    if (selection && !this.#catalog.hasConfiguredAuth(selection.model)) {
      throw new Error(`No API key for ${selection.model.provider}/${selection.model.id}`);
    }
    const previousName = this.#modelPresetState.activeName;
    const previousModel = this.model;
    this.#modelPresetState = {
      ...this.#modelPresetState,
      activeName: preset.name,
      pendingName: undefined,
    };
    // Preserve every explicit preset selection in the tape, including same-name
    // reselects, so replay can reconstruct user-visible switching moments.
    this.sessionManager.appendModelPresetSelection({
      presetName: preset.name,
      previousPresetName: previousName,
      source: request.source ?? "session",
      mainModel: preset.mainModel,
      subagentModels: preset.subagentModels,
      synthetic: preset.synthetic,
    });

    let modelChanged = false;
    if (selection) {
      this.#agent.setModel(selection.model);
      this.applyThinkingLevel(selection.thinkingLevel ?? this.thinkingLevel, {
        persistDefault: false,
      });
      modelChanged =
        !previousModel ||
        previousModel.provider !== selection.model.provider ||
        previousModel.id !== selection.model.id;
      if (modelChanged) {
        await this.clearProviderCacheSessionState();
        this.sessionManager.appendModelChange(selection.model.provider, selection.model.id);
        await this.#runner.emit(
          MODEL_SELECT_EVENT_TYPE,
          {
            type: MODEL_SELECT_EVENT_TYPE,
            model: { provider: selection.model.provider, id: selection.model.id },
            previousModel: previousModel
              ? { provider: previousModel.provider, id: previousModel.id }
              : undefined,
            source: "preset",
          },
          this.createHostContext(),
        );
      }
    }

    return {
      selectedName: preset.name,
      previousName,
      modelChanged,
      queued: false,
      effectiveMainModel: preset.mainModel,
    };
  }

  private async applyQueuedModelPreset(): Promise<void> {
    const pendingName = this.#modelPresetState.pendingName;
    if (!pendingName) {
      return;
    }
    await this.selectModelPreset({ name: pendingName, source: "queued" });
  }

  getContextState(): ContextState {
    return { ...this.#contextState };
  }

  getQueuedPrompts(): readonly BrewvaQueuedPromptView[] {
    return this.#queuedPrompts.map((entry) => entry.view);
  }

  removeQueuedPrompt(promptId: string): boolean {
    const index = this.#queuedPrompts.findIndex((entry) => entry.view.promptId === promptId);
    if (index < 0) {
      return false;
    }
    const entry = this.#queuedPrompts[index];
    if (!entry) {
      return false;
    }
    const removed = this.#agent.removeQueuedMessage(entry.message, entry.view.behavior);
    if (!removed) {
      return false;
    }
    this.#queuedPrompts.splice(index, 1);
    this.#queuedPromptIdsByMessage.delete(entry.message);
    this.emitQueuedPromptChange();
    return true;
  }

  getRegisteredTools(): readonly BrewvaToolDefinition[] {
    return [...this.#registeredTools];
  }

  resolveProviderCacheChannelContext(): { source: string } | "" {
    return resolveChannelContext(this.#activePromptSource);
  }

  async prompt(
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<void> {
    await this[HOSTED_PROMPT_ATTEMPT_DISPATCH](parts, options);
  }

  async [HOSTED_PROMPT_ATTEMPT_DISPATCH](
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<void> {
    await this.waitForProviderCacheSessionClear();
    await this.applyQueuedModelPreset();
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    let currentParts = cloneBrewvaPromptContentParts(parts);
    const command =
      expandPromptTemplates && promptPartsArePlainText(currentParts)
        ? parseCommand(buildBrewvaPromptText(currentParts))
        : null;
    if (command) {
      const handled = await this.tryExecuteRegisteredCommand(command.name, command.args);
      if (handled) {
        await this.flushCommandDispatchBuffer();
        return;
      }
    }

    if (this.#runner.hasHandlers("input")) {
      const result = await this.#runner.emitInput(
        {
          type: "input",
          text: buildBrewvaPromptText(currentParts),
          parts: currentParts,
          source: options?.source,
        },
        this.createHostContext(),
      );
      if (result.action === "handled") {
        return;
      }
      if (result.action === "transform") {
        currentParts = cloneBrewvaPromptContentParts(result.parts);
      }
    }

    if (expandPromptTemplates && promptPartsArePlainText(currentParts)) {
      let expandedText = buildBrewvaPromptText(currentParts);
      expandedText = buildSkillCommandText(expandedText, this.#resourceLoader);
      expandedText = expandBrewvaPromptTemplate(
        expandedText,
        this.#resourceLoader.getPrompts().prompts,
      );
      currentParts = buildTextPromptParts(expandedText);
    }

    if (this.isStreaming) {
      const behavior = options?.streamingBehavior ?? "queue";
      await this.queueUserMessage(currentParts, behavior);
      return;
    }

    if (!this.model) {
      throw new Error("No model selected.");
    }
    if (!this.#catalog.hasConfiguredAuth(this.model as BrewvaRegisteredModel)) {
      throw new Error(`No API key found for ${this.model.provider}/${this.model.id}.`);
    }

    const messages: BrewvaTurnLoopMessage[] = [
      {
        role: "user",
        content: toAgentUserContent(currentParts),
        timestamp: Date.now(),
      },
      ...this.#pendingNextTurnMessages,
    ];
    this.#pendingNextTurnMessages.length = 0;

    const beforeStart = await this.#runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: buildBrewvaPromptText(currentParts),
        parts: cloneBrewvaPromptContentParts(currentParts),
        systemPrompt: this.#baseSystemPrompt,
      },
      this.createHostContext(),
    );
    this.#lastRecallInjectionFingerprint = resolveRecallInjectionFingerprint(beforeStart?.messages);
    if (beforeStart?.messages) {
      for (const message of beforeStart.messages) {
        messages.push({
          role: "custom",
          customType: message.customType,
          content: message.content,
          display: message.display ?? true,
          details: message.details,
          timestamp: Date.now(),
        });
      }
    }

    this.#agent.setSystemPrompt(beforeStart?.systemPrompt ?? this.#baseSystemPrompt);
    await this.syncContextState();
    const previousPromptSource = this.#activePromptSource;
    this.#activePromptSource = normalizePromptSource(options?.source);
    try {
      await this.#agent.prompt(messages);
    } finally {
      this.#activePromptSource = previousPromptSource;
    }
  }

  async steer(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { status: "rejected_empty" };
    }
    if (!this.#agent.steer(trimmed)) {
      return { status: "no_active_run" };
    }
    this.#recordRuntimeEvent(
      STEER_QUEUED_EVENT_TYPE,
      buildSteerAuditPayload(trimmed, {
        source: normalizePromptSource(options?.source) ?? null,
      }),
    );
    return { status: "queued", chars: trimmed.length };
  }

  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  waitForIdle(): Promise<void> {
    return this.#agent.waitForIdle();
  }

  setUiPort(ui: BrewvaToolUiPort): void {
    this.#ui = ui;
  }

  async setModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    const resolved = this.#catalog.find(model.provider, model.id);
    if (!resolved) {
      throw new Error(`Unknown model: ${model.provider}/${model.id}`);
    }
    if (!this.#catalog.hasConfiguredAuth(resolved)) {
      throw new Error(`No API key for ${resolved.provider}/${resolved.id}`);
    }

    const previousModel = this.model;
    this.#agent.setModel(resolved);
    this.setThinkingLevel(this.thinkingLevel);

    if (
      !previousModel ||
      previousModel.provider !== resolved.provider ||
      previousModel.id !== resolved.id
    ) {
      await this.clearProviderCacheSessionState();
      this.sessionManager.appendModelChange(resolved.provider, resolved.id);
      await this.#runner.emit(
        MODEL_SELECT_EVENT_TYPE,
        {
          type: MODEL_SELECT_EVENT_TYPE,
          model: { provider: resolved.provider, id: resolved.id },
          previousModel: previousModel
            ? { provider: previousModel.provider, id: previousModel.id }
            : undefined,
          source: "set",
        },
        this.createHostContext(),
      );
    }
  }

  setThinkingLevel(level: BrewvaPromptThinkingLevel): void {
    this.applyThinkingLevel(level, { persistDefault: true });
  }

  private applyThinkingLevel(
    level: BrewvaPromptThinkingLevel,
    options: { persistDefault: boolean },
  ): void {
    const available = this.getAvailableThinkingLevels();
    const effective = available.includes(level)
      ? level
      : (available[available.length - 1] ?? "off");
    const previousThinkingLevel = this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
    const changed = effective !== previousThinkingLevel;
    this.#agent.setThinkingLevel(toTurnLoopThinkingLevel(effective));
    if (changed) {
      this.sessionManager.appendThinkingLevelChange(effective);
      if (options.persistDefault) {
        this.#settings.setDefaultThinkingLevel(effective);
      }
      void this.#runner
        .emit(
          "thinking_level_select",
          {
            type: "thinking_level_select",
            thinkingLevel: effective,
            previousThinkingLevel,
            source: "set",
          },
          this.createHostContext(),
        )
        .catch(() => undefined);
    }
  }

  async replaceMessages(messages: unknown): Promise<void> {
    if (!Array.isArray(messages)) {
      throw new Error("replaceMessages expects an array of messages.");
    }
    await this.clearProviderCacheSessionState();
    this.#agent.replaceMessages([...messages] as BrewvaTurnLoopMessage[]);
  }

  getAvailableThinkingLevels(): BrewvaPromptThinkingLevel[] {
    const currentModel = this.model;
    if (!currentModel?.reasoning) {
      return ["off"];
    }
    return supportsHostedExtendedThinking(currentModel as BrewvaRegisteredModel)
      ? ["off", "minimal", "low", "medium", "high", "xhigh"]
      : ["off", "minimal", "low", "medium", "high"];
  }

  async abort(): Promise<void> {
    this.#agent.abort();
    await this.#agent.waitForIdle();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSessionWire?.();
    this.#unsubscribeSessionWire = null;
    this.#onDispose?.();
    clearDefaultTurnLifecycleSpine(this, this.sessionManager.getSessionId());
    this.sessionManager.dispose?.();
    this.#listeners.clear();
    void this.#runner.emit(
      "session_shutdown",
      { type: "session_shutdown" },
      this.createHostContext(),
    );
  }

  private async emitSessionStart(): Promise<void> {
    await this.#runner.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      this.createHostContext(),
    );
  }

  private resolveToolSchemaSnapshot(
    tools: readonly BrewvaToolDefinition[],
    invalidationReason: string,
  ): ToolSchemaSnapshot {
    return this.#toolSchemaSnapshotStore.resolve(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      invalidationReason,
    );
  }

  private buildAgentToolsFromSnapshot(
    tools: readonly BrewvaToolDefinition[],
    snapshot: ToolSchemaSnapshot,
  ): BrewvaTurnLoopTool[] {
    const schemasByName = new Map(snapshot.tools.map((tool) => [tool.name, tool]));
    return tools.map((tool) =>
      toAgentTool(tool, () => this.createToolContext(), schemasByName.get(tool.name)),
    );
  }

  private resolveProviderToolSchemaSnapshot(invalidationReason: string): ToolSchemaSnapshot {
    const activeToolNames = new Set(this.getActiveToolNames());
    const activeDefinitions = [...this.#toolDefinitions.values()].filter((tool) =>
      activeToolNames.has(tool.name),
    );
    return this.resolveToolSchemaSnapshot(activeDefinitions, invalidationReason);
  }

  private trackProviderCacheSessionClear(clear: Promise<void>): Promise<void> {
    this.#providerCacheSessionClear = clear;
    void clear
      .finally(() => {
        if (this.#providerCacheSessionClear === clear) {
          this.#providerCacheSessionClear = null;
        }
      })
      .catch(() => undefined);
    return clear;
  }

  private async waitForProviderCacheSessionClear(): Promise<void> {
    await this.#providerCacheSessionClear;
  }

  private clearProviderCacheSessionState(): Promise<void> {
    this.#toolSchemaSnapshotStore.clear("session_clear");
    this.#providerCacheStickyLatches.clear();
    return this.trackProviderCacheSessionClear(
      clearApiProviderSessions(this.sessionManager.getSessionId()),
    );
  }

  private clearProviderCacheSessionStateBestEffort(): void {
    void this.clearProviderCacheSessionState().catch((error) => {
      this.#logger?.warn("provider cache session clear failed", {
        sessionId: this.sessionManager.getSessionId(),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private observeProviderCacheStickyLatches(
    input: Parameters<ProviderCacheStickyLatches["observe"]>[0],
  ) {
    return this.#providerCacheStickyLatches.observe(input);
  }

  private async markSessionCompactedForCacheState(): Promise<void> {
    await this.clearProviderCacheSessionState();
  }

  private refreshTools(): void {
    this.#toolDefinitions.clear();
    this.#toolPromptSnippets.clear();
    this.#toolPromptGuidelines.clear();

    for (const tool of this.#registeredTools) {
      this.indexToolDefinition(tool);
    }

    const toolDefinitions = [...this.#toolDefinitions.values()];
    const snapshot = this.resolveToolSchemaSnapshot(toolDefinitions, "tool_refresh");
    const tools = this.buildAgentToolsFromSnapshot(toolDefinitions, snapshot);
    this.#agent.setTools(tools);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#agent.setSystemPrompt(this.#baseSystemPrompt);
  }

  private registerRuntimePluginTool(tool: BrewvaToolDefinition): void {
    const existingIndex = this.#registeredTools.findIndex(
      (candidate) => candidate.name === tool.name,
    );
    if (existingIndex >= 0) {
      this.#registeredTools[existingIndex] = tool;
    } else {
      this.#registeredTools.push(tool);
    }
    this.indexToolDefinition(tool);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#agent.setSystemPrompt(this.#baseSystemPrompt);
  }

  private indexToolDefinition(tool: BrewvaToolDefinition): void {
    this.#toolDefinitions.set(tool.name, tool);
    const promptSnippet = this.normalizePromptSnippet(tool.promptSnippet);
    if (promptSnippet) {
      this.#toolPromptSnippets.set(tool.name, promptSnippet);
    } else {
      this.#toolPromptSnippets.delete(tool.name);
    }
    const guidelines = this.normalizePromptGuidelines(tool.promptGuidelines);
    if (guidelines.length > 0) {
      this.#toolPromptGuidelines.set(tool.name, guidelines);
    } else {
      this.#toolPromptGuidelines.delete(tool.name);
    }
  }

  private normalizePromptSnippet(text: string | undefined): string | undefined {
    if (!text) {
      return undefined;
    }
    const normalized = text
      .replace(/[\r\n]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }
    return [...new Set(guidelines.map((line) => line.trim()).filter((line) => line.length > 0))];
  }

  private rebuildSystemPrompt(): string {
    const selectedTools = this.getActiveToolNames();
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const toolName of selectedTools) {
      const snippet = this.#toolPromptSnippets.get(toolName);
      if (snippet) {
        toolSnippets[toolName] = snippet;
      }
      const guidelines = this.#toolPromptGuidelines.get(toolName);
      if (guidelines) {
        promptGuidelines.push(...guidelines);
      }
    }

    const loadedSkills = this.#resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
    }));

    return buildBrewvaSystemPrompt({
      cwd: this.#cwd,
      selectedTools,
      toolSnippets,
      promptGuidelines,
      customPrompt: this.#resourceLoader.getSystemPrompt(),
      appendSystemPrompt: this.#resourceLoader.getAppendSystemPrompt().join("\n\n"),
      contextFiles: this.#resourceLoader.getAgentsFiles().agentsFiles,
      skills: loadedSkills,
    });
  }

  private getActiveToolNames(): string[] {
    return this.#agent.state.tools.map((tool) => tool.name);
  }

  private getAllToolInfo(): BrewvaHostToolInfo[] {
    return [...this.#toolDefinitions.values()].map((tool) => {
      const info: BrewvaHostToolInfo = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      if (tool.sourceInfo !== undefined) {
        info.sourceInfo = tool.sourceInfo;
      }
      return info;
    });
  }

  private setActiveTools(toolNames: string[]): void {
    const selectedDefinitions = toolNames
      .map((toolName) => this.#toolDefinitions.get(toolName))
      .filter((tool): tool is BrewvaToolDefinition => tool !== undefined);
    const snapshot = this.resolveToolSchemaSnapshot(selectedDefinitions, "active_tool_set_changed");
    const tools = this.buildAgentToolsFromSnapshot(selectedDefinitions, snapshot);
    this.#agent.setTools(tools);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#agent.setSystemPrompt(this.#baseSystemPrompt);
  }

  private async tryExecuteRegisteredCommand(name: string, args: string): Promise<boolean> {
    const command = this.#runner.getRegisteredCommands().get(name);
    if (!command) {
      return false;
    }
    this.#commandDispatchBuffer = [];
    try {
      await command.handler(args, this.createCommandContext());
      return true;
    } finally {
      if (this.#commandDispatchBuffer?.length === 0) {
        this.#commandDispatchBuffer = null;
      }
    }
  }

  private async flushCommandDispatchBuffer(): Promise<void> {
    const buffer = this.#commandDispatchBuffer;
    this.#commandDispatchBuffer = null;
    if (!buffer || buffer.length === 0) {
      return;
    }
    for (const item of buffer) {
      if (item.kind === "user") {
        await this.prompt(item.parts, {
          expandPromptTemplates: false,
          source: "extension",
        });
        continue;
      }
      await this.sendCustomMessage(item.message, { triggerTurn: true });
    }
  }

  private async queueUserMessage(
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ): Promise<void> {
    const submittedAt = Date.now();
    const promptId = randomUUID();
    const message: QueuedUserMessage = {
      role: "user",
      content: toAgentUserContent(parts),
      timestamp: submittedAt,
    };
    const view: BrewvaQueuedPromptView = Object.freeze({
      promptId,
      text: buildBrewvaPromptText(parts),
      submittedAt,
      behavior,
    });
    this.#queuedPromptIdsByMessage.set(message, promptId);
    this.#queuedPrompts.push({
      view,
      message,
    });
    if (behavior === "followUp") {
      this.#agent.followUp(message);
    } else {
      this.#agent.queue(message);
    }
    this.emitQueuedPromptChange();
  }

  private async sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): Promise<void> {
    const customMessage: Extract<BrewvaTurnLoopMessage, { role: "custom" }> = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display ?? true,
      details: message.details,
      timestamp: Date.now(),
    };

    if (options?.deliverAs === "nextTurn") {
      this.#pendingNextTurnMessages.push(customMessage);
      return;
    }

    if (options?.deliverAs === "transcript") {
      const transcriptMessage = {
        ...customMessage,
        excludeFromContext: true,
      };
      const messageStartEvent = { type: "message_start" as const, message: transcriptMessage };
      const messageEndEvent = { type: "message_end" as const, message: transcriptMessage };
      const transformedStart = await this.emitPluginEvent(messageStartEvent);
      const transformedEnd = await this.emitPluginEvent(messageEndEvent);
      const committedMessage =
        transformedEnd.type === "message_end" && transformedEnd.message.role === "custom"
          ? transformedEnd.message
          : transcriptMessage;
      this.#agent.appendMessage(committedMessage);
      this.emitToListeners(transformedStart);
      this.emitToListeners(transformedEnd);
      await this.syncContextState();
      return;
    }

    if (this.#commandDispatchBuffer && !this.isStreaming && options?.triggerTurn) {
      this.#commandDispatchBuffer.push({ kind: "custom", message });
      return;
    }

    if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.#agent.followUp(customMessage);
      } else {
        this.#agent.queue(customMessage);
      }
      return;
    }

    if (options?.triggerTurn) {
      await this.#agent.prompt(customMessage);
      return;
    }

    const messageStartEvent = { type: "message_start" as const, message: customMessage };
    const messageEndEvent = { type: "message_end" as const, message: customMessage };
    if (this.#runner.hasHandlers("message_end")) {
      const transformedStart = await this.emitPluginEvent(messageStartEvent);
      const transformedEnd = await this.emitPluginEvent(messageEndEvent);
      const committedMessage =
        transformedEnd.type === "message_end" && transformedEnd.message.role === "custom"
          ? transformedEnd.message
          : customMessage;
      this.#agent.appendMessage(committedMessage);
      this.emitToListeners(transformedStart);
      this.emitToListeners(transformedEnd);
    } else {
      this.#agent.appendMessage(customMessage);
      this.sessionManager.appendCustomMessageEntry(
        customMessage.customType,
        customMessage.content,
        customMessage.display,
        customMessage.details,
      );
      this.emitToListeners(messageStartEvent);
      this.emitToListeners(messageEndEvent);
    }
    await this.syncContextState();
  }

  private async sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "queue" | "followUp" },
  ): Promise<void> {
    if (this.#commandDispatchBuffer && !this.isStreaming) {
      this.#commandDispatchBuffer.push({
        kind: "user",
        parts: cloneBrewvaPromptContentParts(content),
      });
      return;
    }

    await this.prompt(content, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      source: "extension",
    });
  }

  private createToolContext(): BrewvaToolContext {
    return {
      ui: this.#ui,
      hasUI: this.#ui !== NOOP_UI,
      cwd: this.#cwd,
      sessionManager: {
        getSessionId: () => this.sessionManager.getSessionId(),
        getLeafId: () => this.sessionManager.getLeafId() ?? null,
      },
      modelRegistry: this.#catalog,
      model: this.model as BrewvaRegisteredModel | undefined,
      isIdle: () => !this.isStreaming,
      signal: this.#agent.signal,
      abort: () => this.#agent.abort(),
      hasPendingMessages: () =>
        this.#agent.hasQueuedMessages() || this.#pendingNextTurnMessages.length > 0,
      shutdown: () => this.dispose(),
      compact: (request) => {
        this.requestCompaction(request);
      },
      getContextUsage: () => undefined,
      getSystemPrompt: () => this.#agent.state.systemPrompt,
    };
  }

  private createHostContext() {
    return this.createToolContext();
  }

  private createCommandContext(): BrewvaHostCommandContext {
    const hostContext = this.createHostContext();
    return {
      ...hostContext,
      waitForIdle: () => this.waitForIdle(),
      newSession: this.#commandUnsupported,
      fork: this.#commandUnsupported,
      navigateTree: this.#commandUnsupported,
      switchSession: this.#commandUnsupported,
      reload: async () => {
        await this.#resourceLoader.reload();
        this.refreshTools();
      },
    };
  }

  private async handleAgentEvent(event: BrewvaTurnLoopEvent): Promise<BrewvaTurnLoopEvent> {
    if (event.type === "message_start" && event.message.role === "user") {
      this.deleteQueuedMessage(event.message);
    }
    if (event.type === "steer_applied") {
      this.#recordRuntimeEvent(
        STEER_APPLIED_EVENT_TYPE,
        buildSteerAuditPayload(event.text, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }),
      );
    }
    if (event.type === "steer_dropped") {
      this.#recordRuntimeEvent(
        STEER_DROPPED_EVENT_TYPE,
        buildSteerAuditPayload(event.text, {
          reason: event.reason,
        }),
      );
    }

    await this.advanceSessionPhaseFromAgentEvent(event);
    const eventForListeners = await this.emitPluginEvent(event);
    this.emitToListeners(eventForListeners as BrewvaPromptSessionEvent);
    await this.syncContextState();
    if (
      eventForListeners.type === "message_end" &&
      eventForListeners.message.role === "toolResult"
    ) {
      await this.executeDeferredCompaction();
      await this.syncContextState();
    }
    if (
      eventForListeners.type === "message_end" &&
      eventForListeners.message.role === "assistant"
    ) {
      this.#onProviderAssistantMessage?.(eventForListeners.message);
    }
    return eventForListeners;
  }

  private requestCompaction(request?: BrewvaCompactionRequest): void {
    if (this.#isCompacting || this.#pendingCompactionRequest) {
      request?.onError?.(new Error("Hosted compaction is already in progress."));
      return;
    }

    this.#pendingCompactionRequest = {
      customInstructions: request?.customInstructions,
      onComplete: request?.onComplete,
      onError: request?.onError,
    };

    if (this.isStreaming) {
      this.#stopAfterCurrentToolResults = true;
      return;
    }

    void this.executeDeferredCompaction();
  }

  private consumeToolResultStop(_toolResults: BrewvaTurnLoopToolResultMessage[]): boolean {
    if (!this.#stopAfterCurrentToolResults) {
      return false;
    }
    this.#stopAfterCurrentToolResults = false;
    return true;
  }

  private async executeDeferredCompaction(): Promise<void> {
    const request = this.#pendingCompactionRequest;
    if (!request || this.#isCompacting) {
      return;
    }

    this.#pendingCompactionRequest = null;
    this.#isCompacting = true;
    let pendingCompactEvent: {
      type: "session_compact";
      compactionEntry: {
        id: string;
        summary: string;
        content: string;
        text: string;
        sourceLeafEntryId: string | null;
        firstKeptEntryId: string;
        tokensBefore: number;
      };
      fromExtension: false;
    } | null = null;
    try {
      const branchEntries = this.sessionManager.getBranch();
      const sessionContext = this.sessionManager.buildSessionContext();
      const sourceLeafEntryId = this.sessionManager.getLeafId() ?? null;
      const summary = buildBrewvaDeterministicCompactionSummary(sessionContext.messages);
      const tokensBefore = estimateBrewvaCompactionTokens(sessionContext.messages);
      const compactId = randomUUID();
      const preview = this.sessionManager.previewCompaction(
        summary,
        tokensBefore,
        compactId,
        sourceLeafEntryId,
      );
      const beforeCompactEvent = {
        type: "session_before_compact" as const,
        preparation: {
          strategy: "deterministic_projection_compaction",
        },
        branchEntries,
        customInstructions: request.customInstructions,
      };
      await this.#runner.emit(
        "session_before_compact",
        beforeCompactEvent,
        this.createHostContext(),
      );
      this.emitToListeners(beforeCompactEvent);

      await this.replaceMessages(preview.context.messages);

      const compactEvent = {
        type: "session_compact" as const,
        compactionEntry: {
          id: preview.compactId,
          summary,
          content: summary,
          text: summary,
          sourceLeafEntryId: preview.sourceLeafEntryId,
          firstKeptEntryId: preview.firstKeptEntryId,
          tokensBefore: preview.tokensBefore,
        },
        fromExtension: false as const,
      };
      pendingCompactEvent = compactEvent;
      try {
        await this.#runner.emit("session_compact", compactEvent, this.createHostContext());
        this.emitToListeners(compactEvent);
        await this.markSessionCompactedForCacheState();
        request.onComplete?.(compactEvent);
      } catch (error) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await Promise.resolve();
          await new Promise((settle) => setTimeout(settle, 0));
          const persistedBranch = this.sessionManager.getBranch();
          const persistedLeaf = persistedBranch[persistedBranch.length - 1];
          const persistedContext = this.sessionManager.buildSessionContext();
          if (
            (persistedLeaf?.type === "compaction" &&
              persistedLeaf.summary === summary &&
              persistedLeaf.firstKeptEntryId === preview.firstKeptEntryId &&
              persistedLeaf.tokensBefore === preview.tokensBefore) ||
            sameSessionMessages(persistedContext.messages, preview.context.messages)
          ) {
            await this.replaceMessages(persistedContext.messages);
            this.emitToListeners(compactEvent);
            await this.markSessionCompactedForCacheState();
            request.onComplete?.(compactEvent);
            return;
          }
        }
        await this.replaceMessages(sessionContext.messages);
        throw error;
      }
    } catch (error) {
      this.#stopAfterCurrentToolResults = false;
      if (pendingCompactEvent) {
        await Promise.resolve();
        await new Promise((settle) => setTimeout(settle, 0));
        const settledBranch = this.sessionManager.getBranch();
        const settledLeaf = settledBranch[settledBranch.length - 1];
        const settledContext = this.sessionManager.buildSessionContext();
        if (settledLeaf?.type === "compaction") {
          await this.replaceMessages(settledContext.messages);
          this.emitToListeners(pendingCompactEvent);
          await this.markSessionCompactedForCacheState();
          request.onComplete?.(pendingCompactEvent);
          return;
        }
      }
      request.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#isCompacting = false;
    }
  }

  private async emitPluginEvent(event: BrewvaTurnLoopEvent): Promise<BrewvaTurnLoopEvent> {
    const ctx = this.createHostContext();
    switch (event.type) {
      case "agent_start":
        await this.#runner.emit("agent_start", { type: "agent_start" }, ctx);
        return event;
      case "agent_end":
        await this.#runner.emit("agent_end", { type: "agent_end", messages: event.messages }, ctx);
        return event;
      case "turn_start":
        this.#turnIndex += 1;
        this.#turnStartTimestamp = Date.now();
        await this.#runner.emit(
          "turn_start",
          {
            type: "turn_start",
            turnIndex: this.#turnIndex,
            timestamp: this.#turnStartTimestamp,
          },
          ctx,
        );
        return event;
      case "turn_end":
        await this.#runner.emit(
          "turn_end",
          {
            type: "turn_end",
            turnIndex: this.#turnIndex,
            message: event.message,
            toolResults: event.toolResults,
          },
          ctx,
        );
        return event;
      case "message_start":
        await this.#runner.emit(
          "message_start",
          { type: "message_start", message: event.message },
          ctx,
        );
        return event;
      case "message_update":
        await this.#runner.emit(
          "message_update",
          {
            type: "message_update",
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          ctx,
        );
        return event;
      case "message_end": {
        const result = await this.#runner.emitMessageEnd(
          { type: "message_end", message: event.message },
          ctx,
        );
        if (result?.visibility === undefined) {
          return event;
        }
        return {
          ...event,
          message: applyMessageEndTransform(event.message, result.visibility),
        };
      }
      case "tool_execution_start":
        await this.#runner.emit(
          "tool_execution_start",
          {
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          ctx,
        );
        return event;
      case "tool_execution_update":
        await this.#runner.emit(
          "tool_execution_update",
          {
            type: "tool_execution_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            partialResult: event.partialResult,
          },
          ctx,
        );
        return event;
      case "tool_execution_end":
        await this.#runner.emit(
          "tool_execution_end",
          {
            type: "tool_execution_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          ctx,
        );
        return event;
      case "tool_execution_phase_change":
        await this.#runner.emit(
          "tool_execution_phase_change",
          {
            type: "tool_execution_phase_change",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: event.phase,
            previousPhase: event.previousPhase,
            args: event.args,
          },
          ctx,
        );
        return event;
      default:
        return event;
    }
  }

  private async advanceSessionPhaseFromAgentEvent(event: BrewvaTurnLoopEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant" || this.getSessionPhase().kind !== "idle") {
          return;
        }
        await this.transitionSessionPhase({
          type: "start_model_stream",
          modelCallId: this.resolveModelCallId(event.message),
          turn: this.resolvePhaseTurn(),
        });
        return;
      case "message_end":
        if (
          event.message.role !== "assistant" ||
          this.getSessionPhase().kind !== "model_streaming"
        ) {
          return;
        }
        await this.transitionSessionPhase({ type: "finish_model_stream" });
        return;
      case "tool_execution_start":
        if (this.getSessionPhase().kind !== "idle") {
          return;
        }
        await this.transitionSessionPhase({
          type: "start_tool_execution",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          turn: this.resolvePhaseTurn(),
        });
        return;
      case "tool_execution_end":
        if (this.getSessionPhase().kind !== "tool_executing") {
          return;
        }
        await this.transitionSessionPhase({ type: "finish_tool_execution" });
        return;
      default:
        return;
    }
  }

  private async advanceSessionPhaseFromRuntimeFactFrame(frame: SessionWireFrame): Promise<void> {
    if (
      frame.type === "turn.transition" &&
      frame.status === "entered" &&
      frame.family === "recovery" &&
      frame.reason === "wal_recovery_resume" &&
      this.getSessionPhase().kind !== "crashed" &&
      this.getSessionPhase().kind !== "recovering" &&
      this.getSessionPhase().kind !== "terminated"
    ) {
      await this.transitionSessionPhase({
        type: "crash",
        crashAt: inferRecoveryCrashPoint(this.getSessionPhase()),
        turn: this.resolvePhaseTurn(),
        recoveryAnchor: `transition:${frame.reason}`,
      });
      await this.transitionSessionPhase({ type: "resume" });
    }
    const next = deriveSessionPhaseFromRuntimeFactFrame(
      this.getSessionPhase(),
      frame,
      this.resolvePhaseTurn(),
    );
    if (!next) {
      return;
    }
    await this.reconcileSessionPhase(next.phase);
    await this.syncContextState();
  }

  private async transitionSessionPhase(event: SessionPhaseEvent): Promise<void> {
    const previousPhase = this.getSessionPhase();
    const next = advanceSessionPhaseResult(previousPhase, event);
    if (!next.ok) {
      throw new Error(next.error);
    }
    const nextPhase = next.phase;
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.#sessionPhase = nextPhase;
    await this.#runner.emit(
      "session_phase_change",
      {
        type: "session_phase_change",
        phase: nextPhase,
        previousPhase,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "session_phase_change",
      phase: nextPhase,
      previousPhase,
    });
  }

  private async reconcileSessionPhase(nextPhase: SessionPhase): Promise<void> {
    const previousPhase = this.getSessionPhase();
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.warnOnIncompatibleReconciledSessionPhase(previousPhase, nextPhase);
    this.#sessionPhase = nextPhase;
    await this.#runner.emit(
      "session_phase_change",
      {
        type: "session_phase_change",
        phase: nextPhase,
        previousPhase,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "session_phase_change",
      phase: nextPhase,
      previousPhase,
    });
  }

  private warnOnIncompatibleReconciledSessionPhase(
    previousPhase: SessionPhase,
    nextPhase: SessionPhase,
  ): void {
    const validationEvent = deriveCompatibilityValidationEvent(previousPhase, nextPhase);
    if (!validationEvent) {
      return;
    }
    if (canTransitionSessionPhase(previousPhase, validationEvent)) {
      return;
    }
    const fields = {
      validationEvent: validationEvent.type,
      previousKind: previousPhase.kind,
      nextKind: nextPhase.kind,
      previousPhase,
      nextPhase,
    };
    if (this.#logger) {
      this.#logger.warn("managed_agent_session_phase_reconcile_mismatch", fields);
      return;
    }
    console.warn("managed_agent_session_phase_reconcile_mismatch", fields);
  }

  private getSessionPhase(): SessionPhase {
    return this.#sessionPhase;
  }

  private resolvePhaseTurn(): number {
    return this.#turnIndex > 0 ? this.#turnIndex : 1;
  }

  private resolveModelCallId(
    message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>,
  ): string {
    return typeof message.responseId === "string" && message.responseId.trim().length > 0
      ? message.responseId
      : `turn:${this.resolvePhaseTurn()}:assistant`;
  }

  private emitToListeners(event: BrewvaPromptSessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  private emitQueuedPromptChange(): void {
    this.emitToListeners({
      type: "queue.changed",
      items: this.getQueuedPrompts(),
    });
  }

  #recordRuntimeEvent(type: string, payload: Record<string, unknown>): void {
    if (!this.#runtime) {
      return;
    }
    this.#runtime.extensions.hosted.events.record({
      sessionId: this.sessionManager.getSessionId(),
      type,
      payload,
    });
  }

  private async syncContextState(): Promise<void> {
    const next = this.sessionManager.readContextState?.() ?? DEFAULT_CONTEXT_STATE;
    if (sameContextState(this.#contextState, next)) {
      return;
    }
    const previousState = this.#contextState;
    this.#contextState = { ...next };
    await this.#runner.emit(
      "context_state_change",
      {
        type: "context_state_change",
        state: this.getContextState(),
        previousState,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "context_state_change",
      state: this.getContextState(),
      previousState,
    });
  }

  private deleteQueuedMessage(message: Extract<BrewvaTurnLoopMessage, { role: "user" }>): void {
    const promptId = this.#queuedPromptIdsByMessage.get(message);
    const index = this.#queuedPrompts.findIndex(
      (entry) => entry.message === message || entry.view.promptId === promptId,
    );
    if (index < 0) {
      return;
    }
    const [entry] = this.#queuedPrompts.splice(index, 1);
    if (entry) {
      this.#queuedPromptIdsByMessage.delete(entry.message);
    }
    this.emitQueuedPromptChange();
  }
}

export async function createBrewvaManagedAgentSession(
  options: CreateBrewvaManagedAgentSessionOptions,
): Promise<BrewvaManagedPromptSession> {
  return BrewvaManagedAgentSession.create(options);
}

function sameSessionPhase(left: SessionPhase, right: SessionPhase): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "idle":
      return true;
    case "model_streaming": {
      const next = right as Extract<SessionPhase, { kind: "model_streaming" }>;
      return left.modelCallId === next.modelCallId && left.turn === next.turn;
    }
    case "tool_executing": {
      const next = right as Extract<SessionPhase, { kind: "tool_executing" }>;
      return (
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "waiting_approval": {
      const next = right as Extract<SessionPhase, { kind: "waiting_approval" }>;
      return (
        left.requestId === next.requestId &&
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "recovering": {
      const next = right as Extract<SessionPhase, { kind: "recovering" }>;
      return left.recoveryAnchor === next.recoveryAnchor && left.turn === next.turn;
    }
    case "crashed": {
      const next = right as Extract<SessionPhase, { kind: "crashed" }>;
      return (
        left.crashAt === next.crashAt &&
        left.turn === next.turn &&
        left.modelCallId === next.modelCallId &&
        left.toolCallId === next.toolCallId &&
        left.recoveryAnchor === next.recoveryAnchor
      );
    }
    case "terminated": {
      const next = right as Extract<SessionPhase, { kind: "terminated" }>;
      return left.reason === next.reason;
    }
  }

  const exhaustive: never = left;
  return exhaustive;
}

function deriveCompatibilityValidationEvent(
  previousPhase: SessionPhase,
  nextPhase: SessionPhase,
): SessionPhaseEvent | null {
  switch (nextPhase.kind) {
    case "idle":
      switch (previousPhase.kind) {
        case "model_streaming":
          return { type: "finish_model_stream" };
        case "tool_executing":
          return { type: "finish_tool_execution" };
        case "waiting_approval":
          return { type: "approval_resolved" };
        case "recovering":
          return { type: "finish_recovery" };
        default:
          return null;
      }
    case "model_streaming":
      return {
        type: "start_model_stream",
        modelCallId: nextPhase.modelCallId,
        turn: nextPhase.turn,
      };
    case "tool_executing":
      return {
        type: "start_tool_execution",
        toolCallId: nextPhase.toolCallId,
        toolName: nextPhase.toolName,
        turn: nextPhase.turn,
      };
    case "waiting_approval":
      return previousPhase.kind === "tool_executing"
        ? {
            type: "wait_for_approval",
            requestId: nextPhase.requestId,
          }
        : null;
    case "recovering":
      return previousPhase.kind === "crashed"
        ? {
            type: "resume",
          }
        : null;
    case "crashed":
      return {
        type: "crash",
        crashAt: nextPhase.crashAt,
        turn: nextPhase.turn,
        recoveryAnchor: nextPhase.recoveryAnchor,
        modelCallId: nextPhase.modelCallId,
        toolCallId: nextPhase.toolCallId,
      };
    case "terminated":
      return {
        type: "terminate",
        reason: nextPhase.reason,
      };
  }
  const exhaustive: never = nextPhase;
  return exhaustive;
}

function sameContextState(left: ContextState, right: ContextState): boolean {
  return (
    left.budgetPressure === right.budgetPressure &&
    left.promptStabilityFingerprint === right.promptStabilityFingerprint &&
    left.transientReductionActive === right.transientReductionActive &&
    left.historyBaselineAvailable === right.historyBaselineAvailable &&
    left.reservedPrimaryTokens === right.reservedPrimaryTokens &&
    left.reservedSupplementalTokens === right.reservedSupplementalTokens &&
    left.lastInjectionScopeId === right.lastInjectionScopeId
  );
}
