import type { NetReuseInputs } from "@brewva/brewva-substrate/context-budget";

export const CONTEXT_EVIDENCE_SAMPLE_SCHEMA = "brewva.context_evidence.sample.v2";
// v3: `wasteful` is now the per-cut net-reuse verdict (netReuseValue < 0),
// replacing the aggregate cache-creation-ratio heuristic (RFC Phase 3).
export const CONTEXT_EVIDENCE_REPORT_SCHEMA = "brewva.context_evidence.report.v3";

export interface PromptStabilityEvidenceSample {
  schema: typeof CONTEXT_EVIDENCE_SAMPLE_SCHEMA;
  kind: "prompt_stability";
  sessionId: string;
  turn: number;
  timestamp: number;
  scopeKey: string;
  stablePrefixHash: string;
  dynamicTailHash: string;
  stablePrefix: boolean;
  stableTail: boolean;
  changedTailBlocks?: readonly string[];
  compactionAdvised: boolean;
  forcedCompaction: boolean;
  usageRatio: number | null;
  pendingCompactionReason: string | null;
  gateRequired: boolean;
}

export interface TransientReductionEvidenceSample {
  schema: typeof CONTEXT_EVIDENCE_SAMPLE_SCHEMA;
  kind: "transient_reduction";
  sessionId: string;
  turn: number;
  timestamp: number;
  status: "completed" | "skipped";
  reason: string | null;
  eligibleToolResults: number;
  clearedToolResults: number;
  clearedChars: number;
  estimatedTokenSavings: number;
  compactionAdvised: boolean;
  forcedCompaction: boolean;
  expectedCacheBreak: boolean;
}

export interface ProviderCacheObservationEvidenceSample {
  schema: typeof CONTEXT_EVIDENCE_SAMPLE_SCHEMA;
  kind: "provider_cache_observation";
  sessionId: string;
  turn: number;
  timestamp: number;
  source: string;
  status: "cold" | "warm" | "break" | "limited";
  classification: string;
  expected: boolean;
  reason: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  changedFields: string[];
}

export type ContextEvidenceSample =
  | PromptStabilityEvidenceSample
  | TransientReductionEvidenceSample
  | ProviderCacheObservationEvidenceSample;

export interface ContextEvidenceArtifactRef {
  artifactRef: string;
  absolutePath: string;
}

export type ContextEvidenceEconomicVerdictKind =
  | "cache_regression"
  | "unaccounted_break"
  | "wasteful";

// Per-verdict provenance so a verdict can be joined back to the specific
// compaction it came from and to the cache observation that confirms it. When the
// grade is `measured`, the joined observation's status/expected/reason are recorded
// so the measurement is auditable (confirm vs refute).
export interface ContextEvidenceVerdictSource {
  kind: ContextEvidenceEconomicVerdictKind;
  compactId?: string;
  observationTurn?: number;
  observationStatus?: "cold" | "warm" | "break";
  observationExpected?: boolean;
  observationReason?: string | null;
}

// Honesty grade (axiom 7): `measured` only when an informative post-compaction
// cache observation (status cold/warm/break — never `limited`) joins this verdict;
// `estimated` when only the economic prediction resolved; `inconclusive` when not
// even that resolved.
export type ContextEvidenceVerdictGrade = "measured" | "estimated" | "inconclusive";

export interface ContextEvidenceEconomicVerdict {
  kind: ContextEvidenceEconomicVerdictKind;
  reason: string;
  metrics: Record<string, number | null>;
  // Additive economics fields (RFC: quantified-compaction-economics). Optional and
  // projection-tolerant: consumers tolerate their absence on the v2 schema.
  source?: ContextEvidenceVerdictSource;
  netReuseValue?: number | null;
  netReuseInputs?: NetReuseInputs | null;
  grade?: ContextEvidenceVerdictGrade;
}

export interface ContextEvidenceSessionReport {
  sessionId: string;
  promptObservedTurns: number;
  stablePrefixTurns: number;
  stablePrefixRate: number | null;
  dynamicTailStableTurns: number;
  dynamicTailStableRate: number | null;
  latestScopeKey: string | null;
  reductionObservedTurns: number;
  reductionCompletedTurns: number;
  reductionSkippedTurns: number;
  totalClearedToolResults: number;
  totalClearedChars: number;
  totalEstimatedTokenSavings: number;
  latestReductionStatus: "completed" | "skipped" | null;
  latestReductionReason: string | null;
  messageUsageTurns: number;
  longSessionEligible: boolean;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  providerInputTokens: number;
  outputTokens: number;
  promptCacheHitRate: number | null;
  uncachedInputTokensPerUsefulTurn: number | null;
  cachedInputTokensPerUsefulTurn: number | null;
  providerInputTokensPerUsefulTurn: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
  cacheAccountingObserved: boolean;
  compactionEvents: number;
  compactionGenerationEvents: number;
  llmPrimaryCompactionEvents: number;
  workbenchPrimaryCompactionEvents: number;
  deterministicEmergencyCompactionEvents: number;
  compactionGenerationInputTokens: number;
  compactionGenerationOutputTokens: number;
  compactionGenerationCacheReadTokens: number;
  compactionGenerationCacheWriteTokens: number;
  compactionGenerationTokens: number;
  compactionGenerationCostUsd: number;
  compactionGenerationCacheAccountingObserved: boolean;
  firstCompactionTurn: number | null;
  completedReductionTurnsBeforeFirstCompaction: number;
  compactionAdvisedPromptTurns: number;
  compactionAdvisedReductionTurns: number;
  forcedCompactionPromptTurns: number;
  forcedCompactionReductionTurns: number;
  continuationAnchorEvents: number;
  continuationAnchorsWithPressureEvidence: number;
  continuationAnchorsDuringPressure: number;
  continuationAnchorsFollowedByCompaction: number;
  latestProviderCacheStatus: "cold" | "warm" | "break" | "limited" | null;
  latestProviderCacheBreakReason: string | null;
  latestProviderCacheUnexpectedBreak: boolean;
  latestProviderCacheChangedFields: string[];
  expectedCacheBreakReductionTurns: number;
  confirmedCacheBreaksAfterReduction: number;
  unconfirmedExpectedCacheBreaks: number;
  compactionsWithPostCacheObservation: number;
  postCompactionCacheWarmObservations: number;
  postCompactionCacheResetObservations: number;
  economicVerdicts: ContextEvidenceEconomicVerdict[];
}

export interface ContextEvidenceAggregateReport {
  sessionsObserved: number;
  promptObservedTurns: number;
  stablePrefixTurns: number;
  stablePrefixRate: number | null;
  dynamicTailStableTurns: number;
  dynamicTailStableRate: number | null;
  reductionObservedTurns: number;
  reductionCompletedTurns: number;
  reductionSkippedTurns: number;
  totalClearedToolResults: number;
  totalClearedChars: number;
  totalEstimatedTokenSavings: number;
  messageUsageTurns: number;
  longSessionEligibleSessions: number;
  longSessionMessageUsageTurns: number;
  totalUncachedInputTokens: number;
  totalCachedInputTokens: number;
  totalProviderInputTokens: number;
  totalOutputTokens: number;
  promptCacheHitRate: number | null;
  longSessionPromptCacheHitRate: number | null;
  uncachedInputTokensPerUsefulTurn: number | null;
  cachedInputTokensPerUsefulTurn: number | null;
  providerInputTokensPerUsefulTurn: number | null;
  inputCostRegressionRatio: number | null;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  sessionsWithReportedCacheRead: number;
  sessionsWithReportedCacheWrite: number;
  sessionsWithObservedCacheAccounting: number;
  totalCompactionEvents: number;
  totalCompactionGenerationEvents: number;
  totalLlmPrimaryCompactionEvents: number;
  totalWorkbenchPrimaryCompactionEvents: number;
  totalDeterministicEmergencyCompactionEvents: number;
  totalCompactionGenerationInputTokens: number;
  totalCompactionGenerationOutputTokens: number;
  totalCompactionGenerationCacheReadTokens: number;
  totalCompactionGenerationCacheWriteTokens: number;
  totalCompactionGenerationTokens: number;
  totalCompactionGenerationCostUsd: number;
  sessionsWithCompactionGenerationCacheAccounting: number;
  totalContinuationAnchorEvents: number;
  totalContinuationAnchorsWithPressureEvidence: number;
  totalContinuationAnchorsDuringPressure: number;
  totalContinuationAnchorsFollowedByCompaction: number;
  sessionsMeetingStablePrefixTarget: number;
  sessionsWithCompletedReduction: number;
  sessionsWithReductionBeforeCompaction: number;
  sessionsWithCompletedReductionAndNoCompaction: number;
  providerCacheBreakObservedSessions: number;
  providerCacheUnexpectedBreakSessions: number;
  providerCacheTtlExpiryBreakSessions: number;
  providerCacheBreakReasonCounts: Record<string, number>;
  providerCacheChangedFieldCounts: Record<string, number>;
  totalExpectedCacheBreakReductionTurns: number;
  totalConfirmedCacheBreaksAfterReduction: number;
  totalUnconfirmedExpectedCacheBreaks: number;
  totalCompactionsWithPostCacheObservation: number;
  totalPostCompactionCacheWarmObservations: number;
  totalPostCompactionCacheResetObservations: number;
  economicVerdictCounts: Record<ContextEvidenceEconomicVerdictKind, number>;
}

export interface ContextEvidencePromotionReadiness {
  stablePrefixTargetMet: boolean;
  reductionEvidenceObserved: boolean;
  cacheAccountingObserved: boolean;
  promptCacheHitTargetMet: boolean;
  promptCacheStopLossPassed: boolean;
  inputCostBaselineObserved: boolean;
  inputCostStopLossPassed: boolean;
  ready: boolean;
  gaps: string[];
}

export interface ContextEvidenceReportOptions {
  sessionIds?: readonly string[];
  longSessionUsefulTurnThreshold?: number;
  promptCacheHitTarget?: number;
  promptCacheHitStopLossFloor?: number;
  baselineUncachedInputTokensPerUsefulTurn?: number | null;
  inputCostRegressionLimit?: number;
}

export interface ContextEvidenceReport {
  schema: typeof CONTEXT_EVIDENCE_REPORT_SCHEMA;
  generatedAt: string;
  workspaceRoot: string;
  sessionIds: string[];
  aggregate: ContextEvidenceAggregateReport;
  promotionReadiness: ContextEvidencePromotionReadiness;
  sessions: ContextEvidenceSessionReport[];
}
