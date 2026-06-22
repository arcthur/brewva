import { finiteNumber, isProtocolRecord } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export const CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE = "context.compaction.advisory" as const;

export const CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE =
  "context.compaction.auto.completed" as const;

export const CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE = "context.compaction.auto.failed" as const;

export const CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE =
  "context.compaction.auto.requested" as const;

export const CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE = "context.compaction.gate.armed" as const;

export const CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE =
  "context.compaction.gate.blocked_tool" as const;

export const CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE =
  "context.compaction.gate.cleared" as const;

export const CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE = "context.compaction.skipped" as const;

export const CONTEXT_COMPOSED_EVENT_TYPE = "context.composed" as const;

export const CONTEXT_ENTRY_RECORDED_EVENT_TYPE = "context.entry.recorded" as const;

export const CRITICAL_WITHOUT_COMPACT_EVENT_TYPE = "context.critical_without_compact" as const;

export interface ContextBudgetUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
  readonly maxOutputTokens?: number | null;
}

export interface ContextStatus extends ProtocolRecord {
  readonly tokensUsed?: number | null;
  readonly tokensTotal?: number | null;
  readonly effectiveTokensTotal?: number | null;
  readonly tokensRemaining?: number | null;
  readonly tokensUntilForcedCompact?: number | null;
  readonly autoCompactLimitTokens?: number | null;
  readonly controllableBaselineTokens?: number | null;
  readonly controllableTokensUsed?: number | null;
  readonly controllableTokensRemaining?: number | null;
  readonly controllableTokensTotal?: number | null;
  readonly controllableContextRemainingRatio?: number | null;
  readonly predictedTurnGrowthTokens?: number | null;
  readonly tokensUntilPredictedOverflow?: number | null;
  readonly predictedOverflow?: boolean;
  readonly usageRatio: number | null;
  readonly hardLimitRatio: number;
  readonly compactionThresholdRatio: number;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
}

export interface ContextCompactionGateStatus extends ProtocolRecord {
  readonly status: ContextStatus;
  readonly required?: boolean;
  readonly reason?: string | null;
  readonly recentCompaction?: boolean;
  readonly windowTurns?: number | null;
  readonly lastCompactionTurn?: number | null;
  readonly turnsSinceCompaction?: number | null;
}

export type ContextCompactionReason = string;

export type ContextEvidenceKind = string;

export interface ContextEvidenceSample {
  readonly kind: ContextEvidenceKind;
  readonly turn: number;
  readonly timestamp: number;
  readonly payload: {
    readonly scopeKey?: string;
    readonly stablePrefixHash?: string;
    readonly dynamicTailHash?: string;
    readonly stablePrefix?: boolean;
    readonly stableTail?: boolean;
    readonly status?: string;
    readonly reason?: string | null;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly bucketKey?: string;
    readonly visibleHistoryReductionHash?: string;
    readonly workbenchContextHash?: string;
    readonly eligibleToolResults?: number;
    readonly clearedToolResults?: number;
    readonly clearedChars?: number;
    readonly estimatedTokenSavings?: number;
    readonly compactionAdvised?: boolean;
    readonly forcedCompaction?: boolean;
    readonly classification?: string | null;
    readonly expectedCacheBreak?: boolean;
    readonly source?: string;
    readonly provider?: string;
    readonly api?: string;
    readonly model?: string;
    readonly driftSource?: ProviderDriftSource;
    readonly attemptedProvider?: string;
    readonly attemptedModel?: string;
    readonly credentialSlot?: string;
    readonly requestedTransport?: string;
    readonly actualTransport?: string;
  };
}

// "transport_fallback" has no emitter yet — surfacing the Codex WS→SSE latch needs a
// provider-core surface decision deferred out of WS3; the variant is forward-shaped.
export type ProviderDriftSource = "fallback_selection" | "transport_fallback";

// A provider-drift sample is a lossy, non-authoritative diagnosis that a
// non-replay optimization shifted: a model fallback was selected, or a transport
// fell back. It re-projects facts the fingerprint/fallback metadata already carry
// into the same evidence sink the cache-break observation uses, so one inspect view
// can read cache + fallback + transport drift through one path. Never replay truth.
export interface ProviderDriftSample {
  readonly source: ProviderDriftSource;
  readonly provider: string;
  readonly reason: string | null;
  readonly attempted?: { readonly provider: string; readonly model: string };
  readonly selected?: {
    readonly provider: string;
    readonly model: string;
    readonly credentialSlot?: string;
  };
  readonly requestedTransport?: string;
  readonly actualTransport?: string;
}

export interface ContextStatusView extends ContextStatus {}

export type ContextAdmission = string;

export type ContextEntryPresentTo = string;

export interface ContextEntryRecord extends ProtocolRecord {
  readonly entryId: string;
  readonly lineageNodeId: string;
  readonly parentEntryId: string | null;
  readonly parentLeafEntryId?: string | null;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly entryKind: string;
  readonly admission: string;
  readonly presentTo: string;
  readonly eventId: string;
  readonly timestamp: number;
  readonly visible?: boolean;
  readonly text?: string;
  readonly kind?: string;
  readonly sourceRefs?: readonly string[];
}

export interface ExpectedProviderCacheBreak {
  readonly classification: string;
  readonly reason: string | null;
}

export interface PromptStabilityState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly scopeKey: string;
  readonly stablePrefixHash: string;
  readonly dynamicTailHash: string;
  readonly stablePrefix: boolean;
  readonly stableTail: boolean;
  readonly tailBlockHashes?: Readonly<Record<string, string>>;
  /** Ids of the dynamic-tail blocks that were added, updated, or removed vs the prior turn (RFC item A). */
  readonly changedTailBlocks?: readonly string[];
}

export interface ProviderCacheBreakObservation {
  readonly status: "cold" | "warm" | "break" | "limited";
  readonly classification: string;
  readonly expected: boolean;
  readonly reason: string | null;
  readonly previousCacheReadTokens?: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheMissTokens: number;
  readonly changedFields: readonly string[];
  readonly thresholdTokens?: number;
  readonly relativeDropThreshold?: number;
}

export type ProviderCacheRetention = "none" | "short" | "long";

export type ProviderCacheStrategy =
  | "explicitCacheMarker"
  | "explicitCachedContent"
  | "promptCacheKey"
  | "implicitPrefix"
  | "unsupported";

export type ProviderCacheCounterSupport = "readWrite" | "readOnly" | "none";

export type ProviderCacheLongRetention = "none" | "1h" | "24h";

export type ProviderCacheReadOnlyWriteMode = "supported" | "unsupported";

export type ProviderSessionContinuationFamily = "openai-responses";

export type ProviderSessionContinuationMode =
  | "websocketConnection"
  | "previousResponseId"
  | "turnStateHeader";

export interface ProviderSessionContinuationCapability {
  readonly family: ProviderSessionContinuationFamily;
  readonly modes: ProviderSessionContinuationMode[];
  readonly authority: "efficiency";
  readonly reason: string;
}

export interface ProviderCacheCapability {
  readonly strategies: ProviderCacheStrategy[];
  readonly cacheCounters: ProviderCacheCounterSupport;
  readonly shortRetention: boolean;
  readonly longRetention: ProviderCacheLongRetention;
  readonly readOnlyWriteMode: ProviderCacheReadOnlyWriteMode;
  readonly continuation?: ProviderSessionContinuationCapability;
  readonly reason: string;
}

export type ProviderCacheRenderStatus = "rendered" | "disabled" | "unsupported" | "degraded";

export interface ProviderCacheRenderResult {
  readonly status: ProviderCacheRenderStatus;
  readonly reason: string;
  readonly renderedRetention: ProviderCacheRetention;
  readonly bucketKey: string;
  readonly capability?: ProviderCacheCapability;
  readonly cachedContentName?: string;
  readonly cachedContentTtlSeconds?: number;
}

export type ProviderCacheRenderState = ProviderCacheRenderResult;

export interface ProviderCacheFingerprintState {
  readonly bucketKey?: string;
  readonly stablePrefixHash?: string;
  readonly dynamicTailHash?: string;
  readonly visibleHistoryReductionHash?: string;
  readonly workbenchContextHash?: string;
}

export interface ProviderCacheObservationInput {
  readonly turn?: number;
  readonly timestamp?: number;
  readonly source: string;
  readonly fingerprint: ProviderCacheFingerprintState;
  readonly render?: ProviderCacheRenderState;
  readonly breakObservation: ProviderCacheBreakObservation;
}

export interface ProviderCacheObservationState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly source: string;
  readonly fingerprint: ProviderCacheFingerprintState;
  readonly render?: ProviderCacheRenderState;
  readonly breakObservation: ProviderCacheBreakObservation;
}

export interface TransientReductionObservationInput extends ProtocolRecord {
  readonly turn?: number;
  readonly timestamp?: number;
  readonly status: "completed" | "skipped";
  readonly reason?: string | null;
  readonly eligibleToolResults: number;
  readonly clearedToolResults: number;
  readonly clearedChars?: number;
  readonly estimatedTokenSavings?: number;
  readonly compactionAdvised?: boolean;
  readonly forcedCompaction?: boolean;
  readonly classification?: string | null;
  readonly expectedCacheBreak?: boolean;
}

export interface TransientReductionState extends ProtocolRecord {
  readonly turn: number;
  readonly updatedAt: number;
  readonly status: "completed" | "skipped";
  readonly reason: string | null;
  readonly eligibleToolResults: number;
  readonly clearedToolResults: number;
  readonly clearedChars: number;
  readonly estimatedTokenSavings: number;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
  readonly classification?: string | null;
  readonly expectedCacheBreak?: boolean;
}

export function coerceContextBudgetUsage(value: unknown): ContextBudgetUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as ProtocolRecord;
  const contextWindow = finiteNumber(record.contextWindow);
  if (contextWindow === null || contextWindow <= 0) {
    return undefined;
  }
  const tokens = finiteNumber(record.tokens);
  const percent = finiteNumber(record.percent);
  const maxOutputTokens = finiteNumber(record.maxOutputTokens);
  return {
    tokens: tokens === null || tokens < 0 ? null : tokens,
    contextWindow,
    percent: percent === null || percent < 0 ? null : percent,
    maxOutputTokens: maxOutputTokens === null || maxOutputTokens <= 0 ? null : maxOutputTokens,
  };
}

export function recordAssistantUsageFromMessage(
  recorder: { readonly recordAssistantUsage?: (usage: ProtocolRecord) => unknown },
  sessionIdOrMessage?: unknown,
  message?: unknown,
): ProtocolRecord {
  const resolvedMessage = typeof sessionIdOrMessage === "string" ? message : sessionIdOrMessage;
  const messageRecord = isProtocolRecord(resolvedMessage) ? resolvedMessage : {};
  const usage =
    messageRecord.usage &&
    typeof messageRecord.usage === "object" &&
    !Array.isArray(messageRecord.usage)
      ? (messageRecord.usage as ProtocolRecord)
      : {};
  recorder.recordAssistantUsage?.(usage);
  return usage;
}

export const readContextEntryRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ContextEntryRecord | null => (event.payload ? (event.payload as ContextEntryRecord) : null);

export function isLlmVisibleContextEntry(entry: ProtocolRecord): boolean {
  return entry.visible !== false;
}
