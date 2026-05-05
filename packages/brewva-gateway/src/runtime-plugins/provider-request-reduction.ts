import { type BrewvaHostedRuntimePort, type ContextBudgetUsage } from "@brewva/brewva-runtime";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  estimateStructuredTokenCount,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
  type TokenEstimatorHints,
} from "@brewva/brewva-token-estimation";
import { getHostedTurnTransitionCoordinator } from "../session/turn-transition.js";
import { recordTransientReductionEvidence } from "./context-evidence.js";

const CLEARED_TOOL_RESULT_PLACEHOLDER = "[cleared_for_request]";
const RECENT_TOOL_RESULT_RETAIN_COUNT = 4;
const MIN_CLEARABLE_TOOL_RESULT_CHARS = 512;
const NON_TEXTUAL_PAYLOAD_TYPES = new Set([
  "image",
  "image_url",
  "image_file",
  "input_image",
  "input_audio",
  "audio",
  "video",
  "file",
  "file_data",
]);
const NON_TEXTUAL_PAYLOAD_KEYS = new Set([
  "image",
  "image_url",
  "imageUrl",
  "image_file",
  "imageFile",
  "input_image",
  "inputImage",
  "input_audio",
  "inputAudio",
  "audio",
  "video",
  "file",
  "file_data",
  "fileData",
]);
const NON_TEXTUAL_STRING_KEYS = new Set([
  "data",
  "bytes",
  "b64_json",
  "base64",
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
]);
const LOW_SIGNAL_STRING_KEYS = new Set([
  "model",
  "provider",
  "type",
  "id",
  "call_id",
  "tool_call_id",
  "response_id",
  "sessionId",
  "session_id",
  "cachePolicy",
  "cache_policy",
  "transport",
  "tool_choice",
  "parallel_tool_calls",
  "encoding",
  "format",
  "role",
]);
interface ReductionCandidate {
  charLength: number;
  clear: () => void;
}

interface ReductionResult {
  payload: unknown;
  status: "completed" | "skipped";
  detail: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars: number;
  estimatedTokenSavings: number;
}

interface ReductionEligibility {
  allowed: boolean;
  detail: string | null;
  pressureLevel: "none" | "low" | "medium" | "high" | "critical" | "unknown";
}

interface PayloadStringContext {
  parent?: Record<string, unknown>;
  key?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function resolveUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
  return resolveContextUsageRatio(usage);
}

function resolveUsageTokens(usage: ContextBudgetUsage | undefined): number | null {
  return resolveContextUsageTokens(usage);
}

function resolveUsageContextWindow(usage: ContextBudgetUsage | undefined): number | null {
  return usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? usage.contextWindow
    : null;
}

function isNonTextualPayloadRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type.toLowerCase() : null;
  if (type && NON_TEXTUAL_PAYLOAD_TYPES.has(type)) {
    return true;
  }
  for (const key of NON_TEXTUAL_PAYLOAD_KEYS) {
    if (key in record) {
      return true;
    }
  }
  return false;
}

function shouldCountPayloadString(value: string, context: PayloadStringContext): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  const key = context.key;
  if (key && LOW_SIGNAL_STRING_KEYS.has(key)) {
    return false;
  }
  if (key && NON_TEXTUAL_STRING_KEYS.has(key)) {
    return false;
  }
  if (context.parent && isNonTextualPayloadRecord(context.parent)) {
    return false;
  }
  return true;
}

function derivePayloadTokenEstimatorHints(
  payload: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): TokenEstimatorHints {
  const record = asRecord(payload);
  const modelId =
    metadata?.modelId ??
    (record && typeof record.model === "string"
      ? record.model
      : record && typeof record.modelId === "string"
        ? record.modelId
        : null);
  const api =
    metadata?.api ??
    (record && typeof record.api === "string"
      ? record.api
      : record && typeof record.providerApi === "string"
        ? record.providerApi
        : null);
  return {
    api,
    provider: metadata?.provider,
    modelId,
  };
}

function estimatePayloadTextTokens(
  value: unknown,
  context: PayloadStringContext = {},
  hints: TokenEstimatorHints = {},
): number {
  if (typeof value === "string") {
    return shouldCountPayloadString(value, context)
      ? estimateStructuredTokenCount(value, hints)
      : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (sum, entry) => sum + estimatePayloadTextTokens(entry, { parent: context.parent }, hints),
      0,
    );
  }

  const record = asRecord(value);
  if (!record) {
    return 0;
  }
  if (isNonTextualPayloadRecord(record)) {
    return 0;
  }

  let total = 0;
  for (const [key, entry] of Object.entries(record)) {
    total += estimatePayloadTextTokens(entry, { parent: record, key }, hints);
  }
  return total;
}

function buildEstimatedPayloadUsage(
  payload: unknown,
  runtimeUsage: ContextBudgetUsage | undefined,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ContextBudgetUsage | undefined {
  const contextWindow = resolveUsageContextWindow(runtimeUsage);
  if (!contextWindow) {
    return undefined;
  }

  const estimatedTokens = estimatePayloadTextTokens(
    payload,
    {},
    derivePayloadTokenEstimatorHints(payload, metadata),
  );
  if (estimatedTokens <= 0) {
    return undefined;
  }

  const usageRatio = Math.max(0, Math.min(1, estimatedTokens / contextWindow));
  return {
    tokens: estimatedTokens,
    contextWindow,
    percent: normalizePercent(usageRatio),
  };
}

function hasUsableRuntimeUsage(runtimeUsage: ContextBudgetUsage | undefined): boolean {
  return (
    resolveUsageContextWindow(runtimeUsage) !== null &&
    (resolveUsageTokens(runtimeUsage) !== null || resolveUsageRatio(runtimeUsage) !== null)
  );
}

function buildEffectiveReductionUsage(
  payload: unknown,
  runtimeUsage: ContextBudgetUsage | undefined,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ContextBudgetUsage | undefined {
  if (hasUsableRuntimeUsage(runtimeUsage)) {
    return runtimeUsage;
  }
  return buildEstimatedPayloadUsage(payload, runtimeUsage, metadata);
}

function buildStringCandidate(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
): ReductionCandidate | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length < MIN_CLEARABLE_TOOL_RESULT_CHARS) {
    return null;
  }
  return {
    charLength: value.length,
    clear: () => {
      parent[key] = CLEARED_TOOL_RESULT_PLACEHOLDER;
    },
  };
}

function buildTextArrayCandidate(
  parent: Record<string, unknown>,
  key: string,
  value: unknown,
  input: {
    textType: string;
    buildReplacement: () => Record<string, unknown>[];
  },
): ReductionCandidate | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  let totalLength = 0;
  for (const part of value) {
    const record = asRecord(part);
    if (!record || record.type !== input.textType || typeof record.text !== "string") {
      return null;
    }
    totalLength += record.text.length;
  }
  if (totalLength < MIN_CLEARABLE_TOOL_RESULT_CHARS) {
    return null;
  }
  return {
    charLength: totalLength,
    clear: () => {
      parent[key] = input.buildReplacement();
    },
  };
}

function collectOpenAIResponsesCandidates(
  inputItems: unknown,
  candidates: ReductionCandidate[],
): void {
  if (!Array.isArray(inputItems)) {
    return;
  }
  for (const item of inputItems) {
    const record = asRecord(item);
    if (!record || record.type !== "function_call_output") {
      continue;
    }
    const stringCandidate = buildStringCandidate(record, "output", record.output);
    if (stringCandidate) {
      candidates.push(stringCandidate);
      continue;
    }
    const textArrayCandidate = buildTextArrayCandidate(record, "output", record.output, {
      textType: "input_text",
      buildReplacement: () => [
        {
          type: "input_text",
          text: CLEARED_TOOL_RESULT_PLACEHOLDER,
        },
      ],
    });
    if (textArrayCandidate) {
      candidates.push(textArrayCandidate);
    }
  }
}

function collectMessageCandidates(messages: unknown, candidates: ReductionCandidate[]): void {
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }

    if (record.role === "tool") {
      const stringCandidate = buildStringCandidate(record, "content", record.content);
      if (stringCandidate) {
        candidates.push(stringCandidate);
      } else {
        const textArrayCandidate = buildTextArrayCandidate(record, "content", record.content, {
          textType: "text",
          buildReplacement: () => [
            {
              type: "text",
              text: CLEARED_TOOL_RESULT_PLACEHOLDER,
            },
          ],
        });
        if (textArrayCandidate) {
          candidates.push(textArrayCandidate);
        }
      }
    }

    if (!Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      const blockRecord = asRecord(block);
      if (!blockRecord || blockRecord.type !== "tool_result") {
        continue;
      }
      const stringCandidate = buildStringCandidate(blockRecord, "content", blockRecord.content);
      if (stringCandidate) {
        candidates.push(stringCandidate);
        continue;
      }
      const textArrayCandidate = buildTextArrayCandidate(
        blockRecord,
        "content",
        blockRecord.content,
        {
          textType: "text",
          buildReplacement: () => [
            {
              type: "text",
              text: CLEARED_TOOL_RESULT_PLACEHOLDER,
            },
          ],
        },
      );
      if (textArrayCandidate) {
        candidates.push(textArrayCandidate);
      }
    }
  }
}

function collectGoogleFunctionResponseCandidates(
  contents: unknown,
  candidates: ReductionCandidate[],
): void {
  if (!Array.isArray(contents)) {
    return;
  }
  for (const content of contents) {
    const contentRecord = asRecord(content);
    if (!contentRecord || !Array.isArray(contentRecord.parts)) {
      continue;
    }
    for (const part of contentRecord.parts) {
      const partRecord = asRecord(part);
      const functionResponse = asRecord(partRecord?.functionResponse);
      if (!functionResponse) {
        continue;
      }
      if (Array.isArray(functionResponse.parts) && functionResponse.parts.length > 0) {
        continue;
      }
      const response = asRecord(functionResponse.response);
      if (!response) {
        continue;
      }
      if (typeof response.output === "string") {
        const candidate = buildStringCandidate(response, "output", response.output);
        if (candidate) {
          candidates.push(candidate);
        }
        continue;
      }
      if (typeof response.error === "string") {
        const candidate = buildStringCandidate(response, "error", response.error);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }
}

function collectReductionCandidates(payload: Record<string, unknown>): ReductionCandidate[] {
  const candidates: ReductionCandidate[] = [];
  collectOpenAIResponsesCandidates(payload.input, candidates);
  collectMessageCandidates(payload.messages, candidates);
  collectGoogleFunctionResponseCandidates(payload.contents, candidates);
  return candidates;
}

function resolveReductionPostureBlockReason(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): string | null {
  const transitionSnapshot = getHostedTurnTransitionCoordinator(runtime).getSnapshot(sessionId);
  if (transitionSnapshot.pendingFamily === "approval") {
    return "approval wait is active";
  }
  if (
    transitionSnapshot.pendingFamily !== null ||
    transitionSnapshot.latest?.status === "entered"
  ) {
    return "recovery posture is active";
  }

  const lifecycle = runtime.inspect.lifecycle.getSnapshot(sessionId);
  if (lifecycle.summary.kind === "degraded" || lifecycle.summary.kind === "recovering") {
    return "recovery posture is active";
  }
  if (
    lifecycle.recovery.pendingFamily !== null ||
    lifecycle.recovery.latestStatus === "entered" ||
    lifecycle.execution.kind === "recovering"
  ) {
    return "recovery posture is active";
  }
  if (lifecycle.execution.kind === "waiting_approval") {
    return "approval wait is active";
  }
  return null;
}

export function resolveTransientOutboundReductionEligibility(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  payload?: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ReductionEligibility {
  if (!runtime.config.infrastructure.contextBudget.enabled) {
    return {
      allowed: false,
      detail: "context budget is disabled",
      pressureLevel: "unknown",
    };
  }

  const postureBlockReason = resolveReductionPostureBlockReason(runtime, sessionId);
  if (postureBlockReason) {
    return {
      allowed: false,
      detail: postureBlockReason,
      pressureLevel: "unknown",
    };
  }

  const usage = buildEffectiveReductionUsage(
    payload,
    runtime.inspect.context.getUsage(sessionId),
    metadata,
  );
  if (!usage) {
    return {
      allowed: false,
      detail: "context usage is unavailable",
      pressureLevel: "unknown",
    };
  }

  const gateStatus = runtime.inspect.context.getCompactionGateStatus(sessionId, usage);
  if (
    gateStatus.required ||
    gateStatus.reason === "hard_limit" ||
    gateStatus.pressure.level === "critical"
  ) {
    return {
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      pressureLevel: gateStatus.pressure.level,
    };
  }

  if (runtime.inspect.context.getPendingCompactionReason(sessionId) === "hard_limit") {
    return {
      allowed: false,
      detail: "hard-limit compaction is already pending",
      pressureLevel: gateStatus.pressure.level,
    };
  }

  if (gateStatus.pressure.level !== "high") {
    return {
      allowed: false,
      detail: "context pressure is below the transient reduction threshold",
      pressureLevel: gateStatus.pressure.level,
    };
  }

  return {
    allowed: true,
    detail: null,
    pressureLevel: gateStatus.pressure.level,
  };
}

export function applyTransientOutboundReductionToPayload(
  payload: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ReductionResult {
  const record = asRecord(payload);
  if (!record) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload is not an object",
      eligibleToolResults: 0,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const cloned = structuredClone(record);
  const hints = derivePayloadTokenEstimatorHints(cloned, metadata);
  const candidates = collectReductionCandidates(cloned);
  if (candidates.length <= RECENT_TOOL_RESULT_RETAIN_COUNT) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload does not contain enough older compactable tool results",
      eligibleToolResults: candidates.length,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const clearedCandidates = candidates.slice(
    0,
    candidates.length - RECENT_TOOL_RESULT_RETAIN_COUNT,
  );
  const clearedChars = clearedCandidates.reduce((sum, candidate) => sum + candidate.charLength, 0);
  for (const candidate of clearedCandidates) {
    candidate.clear();
  }
  const placeholderChars = CLEARED_TOOL_RESULT_PLACEHOLDER.length * clearedCandidates.length;

  return {
    payload: cloned,
    status: "completed",
    detail: null,
    eligibleToolResults: candidates.length,
    clearedToolResults: clearedCandidates.length,
    clearedChars,
    estimatedTokenSavings: Math.max(
      0,
      estimateStructuredTokenCount("x".repeat(clearedChars), hints) -
        estimateStructuredTokenCount("x".repeat(placeholderChars), hints),
    ),
  };
}

function resolveWarmProviderCachePreservationReason(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  result: ReductionResult,
): string | null {
  if (result.status !== "completed" || result.clearedToolResults <= 0) {
    return null;
  }
  const observation = runtime.inspect.context.getProviderCacheObservation(sessionId);
  if (!observation) {
    return null;
  }
  if (observation.render.status !== "rendered" && observation.render.status !== "degraded") {
    return null;
  }
  if (observation.breakObservation.status !== "warm") {
    return null;
  }
  if (observation.breakObservation.cacheReadTokens <= result.estimatedTokenSavings) {
    return null;
  }
  return "warm provider cache is more valuable than transient reduction savings";
}

export function registerProviderRequestReduction(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
): void {
  extensionApi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId().trim();
    if (!sessionId) {
      return undefined;
    }

    const eligibility = resolveTransientOutboundReductionEligibility(
      runtime,
      sessionId,
      event.payload,
      {
        provider: event.provider,
        api: event.api,
        modelId: event.modelId,
      },
    );
    if (!eligibility.allowed) {
      const observed = runtime.maintain.context.observeTransientReduction(sessionId, {
        status: "skipped",
        reason: eligibility.detail,
        eligibleToolResults: 0,
        clearedToolResults: 0,
        pressureLevel: eligibility.pressureLevel,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      recordTransientReductionEvidence({
        workspaceRoot: runtime.workspaceRoot,
        sessionId,
        observed,
      });
      return undefined;
    }

    const result = applyTransientOutboundReductionToPayload(event.payload, {
      provider: event.provider,
      api: event.api,
      modelId: event.modelId,
    });
    const cachePreservationReason = resolveWarmProviderCachePreservationReason(
      runtime,
      sessionId,
      result,
    );
    if (cachePreservationReason) {
      const observed = runtime.maintain.context.observeTransientReduction(sessionId, {
        status: "skipped",
        reason: cachePreservationReason,
        eligibleToolResults: result.eligibleToolResults,
        clearedToolResults: 0,
        clearedChars: 0,
        estimatedTokenSavings: result.estimatedTokenSavings,
        pressureLevel: eligibility.pressureLevel,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      recordTransientReductionEvidence({
        workspaceRoot: runtime.workspaceRoot,
        sessionId,
        observed,
      });
      return undefined;
    }

    const observed = runtime.maintain.context.observeTransientReduction(sessionId, {
      status: result.status,
      reason: result.detail,
      eligibleToolResults: result.eligibleToolResults,
      clearedToolResults: result.clearedToolResults,
      clearedChars: result.clearedChars,
      estimatedTokenSavings: result.estimatedTokenSavings,
      pressureLevel: eligibility.pressureLevel,
      classification:
        result.status === "completed" && result.clearedToolResults > 0
          ? "prefixResetting"
          : "prefixPreserving",
      expectedCacheBreak: result.status === "completed" && result.clearedToolResults > 0,
    });
    recordTransientReductionEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed,
    });
    return result.status === "completed" ? result.payload : undefined;
  });
}

export const PROVIDER_REQUEST_REDUCTION_TEST_ONLY = {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  MIN_CLEARABLE_TOOL_RESULT_CHARS,
  RECENT_TOOL_RESULT_RETAIN_COUNT,
  applyTransientOutboundReductionToPayload,
  buildEffectiveReductionUsage,
  buildEstimatedPayloadUsage,
  estimatePayloadTextTokens,
  resolveTransientOutboundReductionEligibility,
  resolveReductionPostureBlockReason,
};
