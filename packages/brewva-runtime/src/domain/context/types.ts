import type { BrewvaSessionId } from "../../core/identifiers-bridge.js";
import type { RuntimeResult } from "../../core/runtime-result.js";
import type { ResourceBudgetLimits } from "../skills/api.js";

export interface ContextBudgetUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  maxOutputTokens?: number | null;
}

export type TapePressureLevel = "none" | "low" | "medium" | "high";

export type ContextCompactionReason = "usage_threshold" | "hard_limit" | "predicted_overflow";

export interface ContextCompactionGateStatus {
  required: boolean;
  reason: ContextCompactionReason | null;
  status: ContextStatus;
  recentCompaction: boolean;
  windowTurns: number;
  lastCompactionTurn: number | null;
  turnsSinceCompaction: number | null;
}

export interface ContextStatus {
  tokensUsed: number | null;
  tokensTotal: number;
  tokensRemaining: number | null;
  tokensUntilForcedCompact: number | null;
  predictedTurnGrowthTokens: number;
  tokensUntilPredictedOverflow: number | null;
  predictedOverflow: boolean;
  usageRatio: number | null;
  hardLimitRatio: number;
  compactionThresholdRatio: number;
  compactionAdvised: boolean;
  forcedCompaction: boolean;
}

export interface PromptStabilityObservationInput {
  stablePrefixHash: string;
  dynamicTailHash: string;
  contextScopeId?: string;
  turn?: number;
  timestamp?: number;
}

export interface PromptStabilityState {
  turn: number;
  updatedAt: number;
  scopeKey: string;
  stablePrefixHash: string;
  dynamicTailHash: string;
  stablePrefix: boolean;
  stableTail: boolean;
}

export interface TransientReductionObservationInput {
  status: "completed" | "skipped";
  reason?: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars?: number;
  estimatedTokenSavings?: number;
  compactionAdvised?: boolean;
  forcedCompaction?: boolean;
  classification?: ProviderCacheBreakClassification;
  expectedCacheBreak?: boolean;
  turn?: number;
  timestamp?: number;
}

export interface TransientReductionState {
  turn: number;
  updatedAt: number;
  status: "completed" | "skipped";
  reason: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars: number;
  estimatedTokenSavings: number;
  compactionAdvised: boolean;
  forcedCompaction: boolean;
  classification: ProviderCacheBreakClassification | null;
  expectedCacheBreak: boolean;
}

export type ProviderCacheBreakClassification =
  | "prefixPreserving"
  | "prefixResetting"
  | "providerEdit"
  | "cacheCold";

/** Opaque SHA-256 hex digest. Consumers should compare for equality only. */
export type ProviderCacheFingerprintDigest = string;

export interface ProviderCacheFingerprintState {
  bucketKey: string;
  provider: string;
  api: string;
  model: string;
  transport?: string;
  sessionId?: string;
  cachePolicyHash: ProviderCacheFingerprintDigest;
  toolSchemaSnapshotHash: ProviderCacheFingerprintDigest;
  toolSchemaOverlayHash: ProviderCacheFingerprintDigest;
  perToolHashes: Record<string, ProviderCacheFingerprintDigest>;
  stablePrefixHash: ProviderCacheFingerprintDigest;
  dynamicTailHash: ProviderCacheFingerprintDigest;
  requestHash: ProviderCacheFingerprintDigest;
  channelContextHash: ProviderCacheFingerprintDigest;
  renderedCacheHash: ProviderCacheFingerprintDigest;
  cacheCapabilityHash: ProviderCacheFingerprintDigest;
  stickyLatchHash: ProviderCacheFingerprintDigest;
  reasoningHash: ProviderCacheFingerprintDigest;
  thinkingBudgetHash: ProviderCacheFingerprintDigest;
  cacheRelevantHeadersHash: ProviderCacheFingerprintDigest;
  extraBodyHash: ProviderCacheFingerprintDigest;
  visibleHistoryReductionHash: ProviderCacheFingerprintDigest;
  workbenchContextHash: ProviderCacheFingerprintDigest;
  providerFallbackHash: ProviderCacheFingerprintDigest;
}

export type ProviderCacheCapabilityStrategy =
  | "explicitCacheMarker"
  | "explicitCachedContent"
  | "promptCacheKey"
  | "implicitPrefix"
  | "unsupported";

export interface ProviderSessionContinuationCapabilityState {
  family: "openai-responses";
  modes: ("websocketConnection" | "previousResponseId" | "turnStateHeader")[];
  authority: "efficiency";
  reason: string;
}

export interface ProviderCacheCapabilityState {
  strategies: ProviderCacheCapabilityStrategy[];
  cacheCounters: "readWrite" | "readOnly" | "none";
  shortRetention: boolean;
  longRetention: "none" | "1h" | "24h";
  readOnlyWriteMode: "supported" | "unsupported";
  continuation?: ProviderSessionContinuationCapabilityState;
  reason: string;
}

export interface ProviderCacheRenderState {
  status: "rendered" | "disabled" | "unsupported" | "degraded";
  reason: string;
  renderedRetention: "none" | "short" | "long";
  bucketKey: string;
  capability?: ProviderCacheCapabilityState;
  cachedContentName?: string;
  cachedContentTtlSeconds?: number;
}

export interface ProviderCacheBreakObservation {
  status: "cold" | "warm" | "break" | "limited";
  classification: ProviderCacheBreakClassification;
  expected: boolean;
  reason: string | null;
  previousCacheReadTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  thresholdTokens: number;
  relativeDropThreshold: number;
  changedFields: string[];
}

export interface ExpectedProviderCacheBreak {
  classification: Exclude<ProviderCacheBreakClassification, "cacheCold">;
  reason: string;
}

export interface ProviderCacheObservationInput {
  source: string;
  fingerprint: ProviderCacheFingerprintState;
  render: ProviderCacheRenderState;
  breakObservation: ProviderCacheBreakObservation;
  turn?: number;
  timestamp?: number;
}

export interface ProviderCacheObservationState {
  turn: number;
  updatedAt: number;
  source: string;
  fingerprint: ProviderCacheFingerprintState;
  render: ProviderCacheRenderState;
  breakObservation: ProviderCacheBreakObservation;
}

export interface VisibleReadState {
  path: string;
  offset: number;
  limit: number | null;
  encoding: string;
  signatureHash: string;
  visibleHistoryEpoch: number;
  previousReadId: string;
}

export type SessionCompactionOrigin = "extension_api" | "auto_compaction" | "hosted_recovery";
export type HistoryViewBaselineOrigin = SessionCompactionOrigin | "exact_history";

export interface SessionCompactionCommitInput {
  compactId: string;
  sanitizedSummary: string;
  summaryDigest: string;
  sourceTurn: number;
  leafEntryId: string | null;
  referenceContextDigest: string | null;
  fromTokens: number | null;
  toTokens: number | null;
  origin: SessionCompactionOrigin;
  summaryGeneration?: SessionCompactionGenerationMetadata;
  cacheImpact?: SessionCompactionCacheImpact;
}

export interface SessionCompactionGenerationMetadata {
  strategy: string;
  model?: {
    provider: string;
    id: string;
    api: string;
  };
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
      total?: number;
    };
  };
  fallbackReason?: string;
}

export interface SessionCompactionCacheImpactSnapshot {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  bucketKey: string | null;
  stablePrefixHash: ProviderCacheFingerprintDigest | null;
  dynamicTailHash: ProviderCacheFingerprintDigest | null;
  visibleHistoryReductionHash: ProviderCacheFingerprintDigest | null;
  workbenchContextHash: ProviderCacheFingerprintDigest | null;
}

export interface SessionCompactionCacheImpact {
  before: SessionCompactionCacheImpactSnapshot | null;
  after: SessionCompactionCacheImpactSnapshot | null;
  explicitEpochChanges: number;
  prefixBytesChanged: number | null;
  degradedReason: string | null;
}

export interface HistoryViewBaselineSnapshot {
  compactId: string;
  sanitizedSummary: string;
  summaryDigest: string;
  sourceTurn: number;
  leafEntryId: string | null;
  referenceContextDigest: string | null;
  fromTokens: number | null;
  toTokens: number | null;
  origin: HistoryViewBaselineOrigin;
  eventId: string;
  timestamp: number;
  rebuildSource: "receipt" | "cache" | "exact_history";
  diagnostics: string[];
}

export type RecoveryPendingFamily =
  | "context"
  | "output_budget"
  | "approval"
  | "delegation"
  | "interrupt"
  | "recovery";

export type RecoveryPostureMode = "idle" | "resumable" | "degraded" | "diagnostic_only";

export interface RecoveryPostureSnapshot {
  mode: RecoveryPostureMode;
  latestReason: string | null;
  latestStatus: string | null;
  pendingFamily: RecoveryPendingFamily | null;
  degradedReason: string | null;
  duplicateSideEffectSuppressionCount: number;
}

export interface RecoveryWorkingSetSnapshot {
  latestReason: string | null;
  latestStatus: string | null;
  pendingFamily: RecoveryPendingFamily | null;
  taskGoal: string | null;
  taskPhase: string | null;
  taskHealth: string | null;
  acceptanceStatus: string | null;
  openBlockers: number;
  openToolCalls: number;
  duplicateSideEffectSuppressionCount: number;
  resumeContract: string;
}

export interface TapeAnchorState {
  id: string;
  name?: string;
  summary?: string;
  nextSteps?: string;
  turn?: number;
  timestamp: number;
}

export interface OutputSearchTelemetryState {
  recentCalls: number;
  singleQueryCalls: number;
  batchedCalls: number;
  throttledCalls: number;
  blockedCalls: number;
  totalQueries: number;
  totalResults: number;
  averageResultsPerQuery: number | null;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number | null;
  matchLayers: {
    exact: number;
    partial: number;
    fuzzy: number;
    none: number;
  };
  lastThrottleLevel: "normal" | "limited" | "blocked" | "unknown";
  lastTimestamp?: number;
}

export interface TapeStatusState {
  totalEntries: number;
  entriesSinceAnchor: number;
  entriesSinceCheckpoint: number;
  tapePressure: TapePressureLevel;
  thresholds: {
    low: number;
    medium: number;
    high: number;
  };
  lastAnchor?: TapeAnchorState;
  lastCheckpointId?: string;
  outputSearch?: OutputSearchTelemetryState;
}

export type TapeHandoffResult = RuntimeResult<
  {
    eventId: string;
    createdAt: number;
    tapeStatus: TapeStatusState;
  },
  "missing_name" | "event_store_disabled"
>;

export type TapeSearchScope = "current_phase" | "all_phases" | "anchors_only";

export interface TapeSearchMatch {
  eventId: string;
  type: string;
  turn?: number;
  timestamp: number;
  excerpt: string;
}

export interface TapeSearchResult {
  query: string;
  scope: TapeSearchScope;
  scannedEvents: number;
  totalEvents: number;
  matches: TapeSearchMatch[];
}

export interface ContextAdmissionDecision {
  accepted: boolean;
  finalText: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  droppedReason?: "hard_limit";
}

export interface ContextCompactionDecision {
  shouldCompact: boolean;
  reason?: ContextCompactionReason;
  usage?: ContextBudgetUsage;
}

export interface ToolAccessResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export type ResourceLeaseBudget = ResourceBudgetLimits;

export interface ResourceLeaseRecord {
  id: string;
  sessionId: BrewvaSessionId;
  skillName: string;
  reason: string;
  budget: ResourceLeaseBudget;
  createdAt: number;
  expiresAt?: number;
  expiresAfterTurn?: number;
  status: "active" | "expired" | "cancelled";
  cancelledAt?: number;
  cancelledReason?: string;
}

export interface ResourceLeaseRequest {
  reason: string;
  budget?: ResourceLeaseBudget;
  ttlMs?: number;
  ttlTurns?: number;
}

export interface ResourceLeaseQuery {
  includeInactive?: boolean;
  skillName?: string;
}

export type ResourceLeaseResult = RuntimeResult<{ lease: ResourceLeaseRecord }>;

export type ResourceLeaseCancelResult = RuntimeResult<{ lease: ResourceLeaseRecord }>;

export interface ParallelAcquireResult {
  accepted: boolean;
  reason?:
    | "disabled"
    | "max_concurrent"
    | "max_total"
    | "skill_max_parallel"
    | "timeout"
    | "cancelled";
}
