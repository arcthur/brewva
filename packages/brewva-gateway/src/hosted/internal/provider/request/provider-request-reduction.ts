import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  ProviderCacheObservationState,
} from "@brewva/brewva-runtime/context";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  estimateProviderPayloadTextTokens,
  estimateStructuredTokenCount,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
} from "@brewva/brewva-token-estimation";
import { recordTransientReductionEvidence } from "../../context/evidence/context-evidence.js";
import { getHostedTurnTransitionCoordinator } from "../../thread-loop/turn-transition.js";

const CLEARED_TOOL_RESULT_PLACEHOLDER = "[cleared_for_request]";
const RECENT_TOOL_RESULT_RETAIN_COUNT = 4;
const MIN_CLEARABLE_TOOL_RESULT_CHARS = 512;
const DEFAULT_TAIL_PROTECT_TOKENS = 40_000;
const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  "workbench_note",
  "workbench_evict",
  "workbench_undo_evict",
  "workbench_compact",
  "recall_search",
  "recall_curate",
  "tape_handoff",
];
interface ReductionCandidate {
  charLength: number;
  toolName?: string;
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
  compactionAdvised: boolean;
  forcedCompaction: boolean;
  cacheCold: boolean;
}

type TransientReductionObservationInput = Parameters<
  BrewvaHostedRuntimePort["operator"]["context"]["prompt"]["observeTransientReduction"]
>[1];

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

  const estimatedTokens = estimateProviderPayloadTextTokens(payload, metadata);
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

function parseRetentionHours(value: string | undefined): number | null {
  if (!value || value === "none") {
    return null;
  }
  const match = /^(\d+)h$/.exec(value);
  if (!match?.[1]) {
    return null;
  }
  return Math.max(1, Number.parseInt(match[1], 10));
}

function resolveProviderCacheTtlMs(observation: ProviderCacheObservationState): number | null {
  const explicitTtlSeconds = observation.render.cachedContentTtlSeconds;
  if (
    typeof explicitTtlSeconds === "number" &&
    Number.isFinite(explicitTtlSeconds) &&
    explicitTtlSeconds > 0
  ) {
    return Math.trunc(explicitTtlSeconds) * 1000;
  }
  if (observation.render.renderedRetention === "short") {
    return 5 * 60 * 1000;
  }
  if (observation.render.renderedRetention === "long") {
    const hours = parseRetentionHours(observation.render.capability?.longRetention);
    return (hours ?? 1) * 60 * 60 * 1000;
  }
  return null;
}

function isProviderCacheLikelyCold(
  observation: ProviderCacheObservationState | undefined,
): boolean {
  if (!observation) {
    return false;
  }
  const breakObservation = observation.breakObservation;
  if (breakObservation.status === "cold") {
    return true;
  }
  if (
    typeof breakObservation.reason === "string" &&
    breakObservation.reason.startsWith("possible_cache_ttl_expiry_")
  ) {
    return true;
  }
  const ttlMs = resolveProviderCacheTtlMs(observation);
  if (ttlMs === null) {
    return false;
  }
  return Math.max(0, Date.now() - observation.updatedAt) >= ttlMs;
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
  const toolNameByCallId = new Map<string, string>();
  for (const item of inputItems) {
    const record = asRecord(item);
    if (!record || record.type !== "function_call") {
      continue;
    }
    if (typeof record.call_id === "string" && typeof record.name === "string") {
      toolNameByCallId.set(record.call_id, record.name);
    }
  }
  for (const item of inputItems) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    if (record.type === "function_call_output") {
      const callId = typeof record.call_id === "string" ? record.call_id : undefined;
      const toolName = callId ? (toolNameByCallId.get(callId) ?? callId) : undefined;
      const stringCandidate = buildStringCandidate(record, "output", record.output);
      if (stringCandidate) {
        candidates.push({ ...stringCandidate, toolName });
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
        candidates.push({ ...textArrayCandidate, toolName });
      }
    }
  }
}

function collectMessageToolNameById(messages: readonly unknown[]): Map<string, string> {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }
    if (Array.isArray(record.tool_calls)) {
      for (const toolCall of record.tool_calls) {
        const toolCallRecord = asRecord(toolCall);
        if (!toolCallRecord || typeof toolCallRecord.id !== "string") {
          continue;
        }
        const functionRecord = asRecord(toolCallRecord.function);
        const name =
          typeof functionRecord?.name === "string"
            ? functionRecord.name
            : typeof toolCallRecord.name === "string"
              ? toolCallRecord.name
              : undefined;
        if (name) {
          toolNameById.set(toolCallRecord.id, name);
        }
      }
    }
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (const block of record.content) {
      const blockRecord = asRecord(block);
      if (
        !blockRecord ||
        (blockRecord.type !== "tool_use" && blockRecord.type !== "toolCall") ||
        typeof blockRecord.id !== "string" ||
        typeof blockRecord.name !== "string"
      ) {
        continue;
      }
      toolNameById.set(blockRecord.id, blockRecord.name);
    }
  }
  return toolNameById;
}

function collectMessageCandidates(messages: unknown, candidates: ReductionCandidate[]): void {
  if (!Array.isArray(messages)) {
    return;
  }
  const toolNameById = collectMessageToolNameById(messages);
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) {
      continue;
    }

    if (record.role === "tool") {
      const toolCallId =
        typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : typeof record.tool_use_id === "string"
            ? record.tool_use_id
            : undefined;
      const toolName =
        typeof record.name === "string"
          ? record.name
          : typeof record.tool_name === "string"
            ? record.tool_name
            : toolCallId
              ? toolNameById.get(toolCallId)
              : undefined;
      const stringCandidate = buildStringCandidate(record, "content", record.content);
      if (stringCandidate) {
        candidates.push({ ...stringCandidate, toolName });
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
          candidates.push({ ...textArrayCandidate, toolName });
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
      const toolUseId =
        typeof blockRecord.tool_use_id === "string"
          ? blockRecord.tool_use_id
          : typeof blockRecord.tool_call_id === "string"
            ? blockRecord.tool_call_id
            : typeof blockRecord.id === "string"
              ? blockRecord.id
              : undefined;
      const toolName =
        typeof blockRecord.name === "string"
          ? blockRecord.name
          : typeof blockRecord.tool_name === "string"
            ? blockRecord.tool_name
            : toolUseId
              ? toolNameById.get(toolUseId)
              : undefined;
      const stringCandidate = buildStringCandidate(blockRecord, "content", blockRecord.content);
      if (stringCandidate) {
        candidates.push({ ...stringCandidate, toolName });
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
        candidates.push({ ...textArrayCandidate, toolName });
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
      const toolName =
        typeof functionResponse.name === "string" ? functionResponse.name : undefined;
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
          candidates.push({ ...candidate, toolName });
        }
        continue;
      }
      if (typeof response.error === "string") {
        const candidate = buildStringCandidate(response, "error", response.error);
        if (candidate) {
          candidates.push({ ...candidate, toolName });
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
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const postureBlockReason = resolveReductionPostureBlockReason(runtime, sessionId);
  if (postureBlockReason) {
    return {
      allowed: false,
      detail: postureBlockReason,
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const usage = buildEffectiveReductionUsage(
    payload,
    runtime.inspect.context.usage.get(sessionId),
    metadata,
  );
  if (!usage) {
    return {
      allowed: false,
      detail: "context usage is unavailable",
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const gateStatus = runtime.inspect.context.compaction.getGateStatus(sessionId, usage);
  const cacheCold = isProviderCacheLikelyCold(
    runtime.inspect.context.providerCache.getObservation(sessionId),
  );
  if (
    gateStatus.required ||
    gateStatus.reason === "hard_limit" ||
    gateStatus.status.forcedCompaction
  ) {
    return {
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      compactionAdvised: gateStatus.status.compactionAdvised,
      forcedCompaction: gateStatus.status.forcedCompaction,
      cacheCold,
    };
  }

  if (runtime.inspect.context.compaction.getPendingReason(sessionId) === "hard_limit") {
    return {
      allowed: false,
      detail: "hard-limit compaction is already pending",
      compactionAdvised: gateStatus.status.compactionAdvised,
      forcedCompaction: gateStatus.status.forcedCompaction,
      cacheCold,
    };
  }

  if (!gateStatus.status.compactionAdvised && !cacheCold) {
    return {
      allowed: false,
      detail: "context status is below the transient reduction threshold",
      compactionAdvised: gateStatus.status.compactionAdvised,
      forcedCompaction: gateStatus.status.forcedCompaction,
      cacheCold,
    };
  }

  return {
    allowed: true,
    detail: null,
    compactionAdvised: gateStatus.status.compactionAdvised,
    forcedCompaction: gateStatus.status.forcedCompaction,
    cacheCold,
  };
}

export function applyTransientOutboundReductionToPayload(
  payload: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
  options?: {
    protectedTools?: readonly string[];
    tailProtectTokens?: number;
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
  const hints = metadata;
  const candidates = collectReductionCandidates(cloned);
  const protectedTools = new Set(options?.protectedTools ?? DEFAULT_PROTECTED_TOOLS);
  const nonProtectedCandidates = candidates.filter(
    (c) => !c.toolName || !protectedTools.has(c.toolName),
  );

  if (nonProtectedCandidates.length <= RECENT_TOOL_RESULT_RETAIN_COUNT) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload does not contain enough older compactable tool results",
      eligibleToolResults: nonProtectedCandidates.length,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const tailProtectTokens = options?.tailProtectTokens ?? DEFAULT_TAIL_PROTECT_TOKENS;
  const alwaysRetainedStart = nonProtectedCandidates.length - RECENT_TOOL_RESULT_RETAIN_COUNT;

  // Walk backward from the tail boundary, accumulating token estimates.
  // Candidates whose cumulative tail is within the tail-protect budget are also safe.
  // Everything before that boundary is eligible for clearing.
  let tailAccum = 0;
  let firstClearableIndex = alwaysRetainedStart;
  for (let i = alwaysRetainedStart - 1; i >= 0; i--) {
    tailAccum += Math.max(0, Math.trunc(nonProtectedCandidates[i]!.charLength / 4));
    if (tailAccum > tailProtectTokens) {
      // Accumulated tail exceeds the budget — all candidates before this point are clearable.
      firstClearableIndex = i + 1;
      break;
    }
    // This candidate's tail still fits in the budget — it is protected.
    firstClearableIndex = i;
  }

  const clearedCandidates = nonProtectedCandidates.slice(0, firstClearableIndex);

  if (clearedCandidates.length === 0) {
    return {
      payload,
      status: "skipped",
      detail: "tail protect budget preserves all eligible candidates",
      eligibleToolResults: nonProtectedCandidates.length,
      clearedToolResults: 0,
      clearedChars: 0,
      estimatedTokenSavings: 0,
    };
  }

  const clearedChars = clearedCandidates.reduce((sum, candidate) => sum + candidate.charLength, 0);
  for (const candidate of clearedCandidates) {
    candidate.clear();
  }
  const placeholderChars = CLEARED_TOOL_RESULT_PLACEHOLDER.length * clearedCandidates.length;

  return {
    payload: cloned,
    status: "completed",
    detail: null,
    eligibleToolResults: nonProtectedCandidates.length,
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
  const observation = runtime.inspect.context.providerCache.getObservation(sessionId);
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

function observeAndRecordTransientReduction(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  input: TransientReductionObservationInput,
): void {
  const observed = runtime.operator.context.prompt.observeTransientReduction(sessionId, input);
  recordTransientReductionEvidence({
    workspaceRoot: runtime.identity.workspaceRoot,
    sessionId,
    observed,
  });
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
      observeAndRecordTransientReduction(runtime, sessionId, {
        status: "skipped",
        reason: eligibility.detail,
        eligibleToolResults: 0,
        clearedToolResults: 0,
        compactionAdvised: eligibility.compactionAdvised,
        forcedCompaction: eligibility.forcedCompaction,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      return undefined;
    }

    const result = applyTransientOutboundReductionToPayload(
      event.payload,
      {
        provider: event.provider,
        api: event.api,
        modelId: event.modelId,
      },
      {
        protectedTools: runtime.config.infrastructure.contextBudget.compaction.protectedTools,
        tailProtectTokens: runtime.config.infrastructure.contextBudget.compaction.tailProtectTokens,
      },
    );
    const cachePreservationReason = eligibility.cacheCold
      ? null
      : resolveWarmProviderCachePreservationReason(runtime, sessionId, result);
    if (cachePreservationReason) {
      observeAndRecordTransientReduction(runtime, sessionId, {
        status: "skipped",
        reason: cachePreservationReason,
        eligibleToolResults: result.eligibleToolResults,
        clearedToolResults: 0,
        clearedChars: 0,
        estimatedTokenSavings: result.estimatedTokenSavings,
        compactionAdvised: eligibility.compactionAdvised,
        forcedCompaction: eligibility.forcedCompaction,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      return undefined;
    }

    observeAndRecordTransientReduction(runtime, sessionId, {
      status: result.status,
      reason: result.detail,
      eligibleToolResults: result.eligibleToolResults,
      clearedToolResults: result.clearedToolResults,
      clearedChars: result.clearedChars,
      estimatedTokenSavings: result.estimatedTokenSavings,
      compactionAdvised: eligibility.compactionAdvised,
      forcedCompaction: eligibility.forcedCompaction,
      classification:
        result.status === "completed" && result.clearedToolResults > 0
          ? eligibility.cacheCold
            ? "cacheCold"
            : "prefixResetting"
          : "prefixPreserving",
      expectedCacheBreak:
        !eligibility.cacheCold && result.status === "completed" && result.clearedToolResults > 0,
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
  estimatePayloadTextTokens: estimateProviderPayloadTextTokens,
  resolveTransientOutboundReductionEligibility,
  resolveReductionPostureBlockReason,
};
