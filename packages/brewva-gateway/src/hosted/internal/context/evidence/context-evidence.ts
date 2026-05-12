import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  BrewvaHostedRuntimePort,
  BrewvaRuntime,
  ProviderCacheObservationState,
} from "@brewva/brewva-runtime";
import {
  ensureParentDirectory,
  normalizeRelativePath,
  readContextEvidenceSamples,
  resolveEvidenceDir,
} from "./context-evidence/store.js";
import {
  CONTEXT_EVIDENCE_REPORT_SCHEMA,
  type ContextEvidenceAggregateReport,
  type ContextEvidenceArtifactRef,
  type ContextEvidencePromotionReadiness,
  type ContextEvidenceReport,
  type ContextEvidenceReportOptions,
  type ContextEvidenceSessionReport,
  type PromptStabilityEvidenceSample,
  type ProviderCacheObservationEvidenceSample,
  type TransientReductionEvidenceSample,
} from "./context-evidence/types.js";

export type {
  ContextEvidenceAggregateReport,
  ContextEvidenceArtifactRef,
  ContextEvidencePromotionReadiness,
  ContextEvidenceReport,
  ContextEvidenceReportOptions,
  ContextEvidenceSample,
  ContextEvidenceSessionReport,
  PromptStabilityEvidenceSample,
  ProviderCacheObservationEvidenceSample,
  TransientReductionEvidenceSample,
} from "./context-evidence/types.js";

export {
  readContextEvidenceRecords,
  readContextEvidenceSamples,
  recordPromptStabilityEvidence,
  recordProviderCacheObservationEvidence,
  recordTransientReductionEvidence,
} from "./context-evidence/store.js";

const REPORT_FILE_NAME = "report-latest.json";
const DEFAULT_LONG_SESSION_USEFUL_TURNS = 10;
const DEFAULT_PROMPT_CACHE_HIT_TARGET = 0.8;
const DEFAULT_PROMPT_CACHE_HIT_STOP_LOSS_FLOOR = 0.7;
const DEFAULT_INPUT_COST_REGRESSION_LIMIT = 0.4;

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeThreshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

function extractReportedCacheFieldFlags(payload: unknown): {
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  const record = usage as {
    cacheReadReported?: unknown;
    cacheWriteReported?: unknown;
  };
  return {
    cacheReadReported: record.cacheReadReported === true,
    cacheWriteReported: record.cacheWriteReported === true,
  };
}

interface MessageUsageMetrics {
  usefulTurns: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  providerInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadReported: boolean;
  cacheWriteReported: boolean;
}

function emptyMessageUsageMetrics(): MessageUsageMetrics {
  return {
    usefulTurns: 0,
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    providerInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadReported: false,
    cacheWriteReported: false,
  };
}

function extractMessageUsageMetrics(payload: unknown): MessageUsageMetrics {
  const metrics = emptyMessageUsageMetrics();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return metrics;
  }
  const record = payload as { role?: unknown; stopReason?: unknown; usage?: unknown };
  if (typeof record.role === "string" && record.role !== "assistant") {
    return metrics;
  }
  if (record.stopReason === "error" || record.stopReason === "aborted") {
    return metrics;
  }
  if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
    return metrics;
  }

  const usage = record.usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
  };
  metrics.uncachedInputTokens = readNonNegativeFiniteNumber(usage.input);
  metrics.cachedInputTokens = readNonNegativeFiniteNumber(usage.cacheRead);
  metrics.providerInputTokens = metrics.uncachedInputTokens + metrics.cachedInputTokens;
  metrics.outputTokens = readNonNegativeFiniteNumber(usage.output);
  metrics.cacheWriteTokens = readNonNegativeFiniteNumber(usage.cacheWrite);
  metrics.cacheReadReported =
    typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead);
  metrics.cacheWriteReported =
    typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite);
  metrics.usefulTurns =
    metrics.providerInputTokens + metrics.outputTokens + metrics.cacheWriteTokens > 0 ? 1 : 0;
  return metrics;
}

function sumMessageUsageMetrics(events: readonly { payload?: unknown }[]): MessageUsageMetrics {
  return events.reduce((sum, event) => {
    const current = extractMessageUsageMetrics(event.payload);
    return {
      usefulTurns: sum.usefulTurns + current.usefulTurns,
      uncachedInputTokens: sum.uncachedInputTokens + current.uncachedInputTokens,
      cachedInputTokens: sum.cachedInputTokens + current.cachedInputTokens,
      providerInputTokens: sum.providerInputTokens + current.providerInputTokens,
      outputTokens: sum.outputTokens + current.outputTokens,
      cacheWriteTokens: sum.cacheWriteTokens + current.cacheWriteTokens,
      cacheReadReported: sum.cacheReadReported || current.cacheReadReported,
      cacheWriteReported: sum.cacheWriteReported || current.cacheWriteReported,
    };
  }, emptyMessageUsageMetrics());
}

interface CompactionGenerationMetrics {
  events: number;
  llmPrimaryEvents: number;
  deterministicEmergencyEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheAccountingObserved: boolean;
}

function emptyCompactionGenerationMetrics(): CompactionGenerationMetrics {
  return {
    events: 0,
    llmPrimaryEvents: 0,
    deterministicEmergencyEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cacheAccountingObserved: false,
  };
}

function readNonNegativeFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readCompactionGenerationMetrics(payload: unknown): CompactionGenerationMetrics {
  const metrics = emptyCompactionGenerationMetrics();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return metrics;
  }

  const summaryGeneration = (payload as { summaryGeneration?: unknown }).summaryGeneration;
  if (
    !summaryGeneration ||
    typeof summaryGeneration !== "object" ||
    Array.isArray(summaryGeneration)
  ) {
    return metrics;
  }

  const generation = summaryGeneration as { strategy?: unknown; usage?: unknown };
  if (typeof generation.strategy !== "string" || generation.strategy.trim().length === 0) {
    return metrics;
  }

  metrics.events = 1;
  if (generation.strategy === "llm_primary_compaction") {
    metrics.llmPrimaryEvents = 1;
  }
  if (generation.strategy === "deterministic_emergency_compaction") {
    metrics.deterministicEmergencyEvents = 1;
  }

  if (
    !generation.usage ||
    typeof generation.usage !== "object" ||
    Array.isArray(generation.usage)
  ) {
    return metrics;
  }

  const usage = generation.usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: unknown;
  };
  metrics.inputTokens = readNonNegativeFiniteNumber(usage.input);
  metrics.outputTokens = readNonNegativeFiniteNumber(usage.output);
  metrics.cacheReadTokens = readNonNegativeFiniteNumber(usage.cacheRead);
  metrics.cacheWriteTokens = readNonNegativeFiniteNumber(usage.cacheWrite);
  metrics.totalTokens =
    readNonNegativeFiniteNumber(usage.totalTokens) ||
    metrics.inputTokens + metrics.outputTokens + metrics.cacheWriteTokens;
  metrics.costUsd =
    usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
      ? readNonNegativeFiniteNumber((usage.cost as { total?: unknown }).total)
      : 0;
  metrics.cacheAccountingObserved = metrics.cacheReadTokens > 0 || metrics.cacheWriteTokens > 0;
  return metrics;
}

function sumCompactionGenerationMetrics(
  events: readonly { payload?: unknown }[],
): CompactionGenerationMetrics {
  return events.reduce((sum, event) => {
    const current = readCompactionGenerationMetrics(event.payload);
    return {
      events: sum.events + current.events,
      llmPrimaryEvents: sum.llmPrimaryEvents + current.llmPrimaryEvents,
      deterministicEmergencyEvents:
        sum.deterministicEmergencyEvents + current.deterministicEmergencyEvents,
      inputTokens: sum.inputTokens + current.inputTokens,
      outputTokens: sum.outputTokens + current.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + current.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + current.cacheWriteTokens,
      totalTokens: sum.totalTokens + current.totalTokens,
      costUsd: sum.costUsd + current.costUsd,
      cacheAccountingObserved: sum.cacheAccountingObserved || current.cacheAccountingObserved,
    };
  }, emptyCompactionGenerationMetrics());
}

function countScopeAwareStablePrefixTurns(
  promptSamples: readonly PromptStabilityEvidenceSample[],
): number {
  let previous: PromptStabilityEvidenceSample | undefined;
  let stableTurns = 0;

  for (const sample of promptSamples) {
    const seedsNewScope = previous === undefined || previous.scopeKey !== sample.scopeKey;
    if (seedsNewScope || sample.stablePrefix) {
      stableTurns += 1;
    }
    previous = sample;
  }

  return stableTurns;
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countByString(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    if (value.length > 0) {
      incrementCount(counts, value);
    }
  }
  return counts;
}

function isTtlProviderCacheBreakReason(reason: string | null): boolean {
  return reason !== null && reason.startsWith("possible_cache_ttl_expiry_");
}

interface ProviderCacheEvidenceProjection {
  timestamp: number;
  turn: number;
  status: "cold" | "warm" | "break" | "limited";
  reason: string | null;
  unexpectedBreak: boolean;
  changedFields: string[];
}

function projectProviderCacheEvidenceSample(
  sample: ProviderCacheObservationEvidenceSample,
): ProviderCacheEvidenceProjection {
  return {
    timestamp: sample.timestamp,
    turn: sample.turn,
    status: sample.status,
    reason: sample.reason,
    unexpectedBreak: sample.status === "break" && !sample.expected,
    changedFields: [...sample.changedFields],
  };
}

function projectProviderCacheObservation(
  observation: ProviderCacheObservationState | undefined,
): ProviderCacheEvidenceProjection | null {
  if (!observation) {
    return null;
  }
  return {
    timestamp: observation.updatedAt,
    turn: observation.turn,
    status: observation.breakObservation.status,
    reason: observation.breakObservation.reason,
    unexpectedBreak:
      observation.breakObservation.status === "break" && !observation.breakObservation.expected,
    changedFields: [...observation.breakObservation.changedFields],
  };
}

function resolveLatestProviderCacheEvidence(
  samples: readonly ProviderCacheObservationEvidenceSample[],
  liveObservation: ProviderCacheObservationState | undefined,
): ProviderCacheEvidenceProjection | null {
  const liveProjection = projectProviderCacheObservation(liveObservation);
  return (
    [
      ...samples.map((sample) => projectProviderCacheEvidenceSample(sample)),
      ...(liveProjection ? [liveProjection] : []),
    ]
      .toSorted((left, right) => {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp - right.timestamp;
        }
        return left.turn - right.turn;
      })
      .at(-1) ?? null
  );
}

export function buildContextEvidenceReport(
  runtime: Pick<BrewvaRuntime | BrewvaHostedRuntimePort, "workspaceRoot" | "inspect">,
  options: ContextEvidenceReportOptions = {},
): ContextEvidenceReport {
  const longSessionUsefulTurnThreshold = normalizePositiveInteger(
    options.longSessionUsefulTurnThreshold,
    DEFAULT_LONG_SESSION_USEFUL_TURNS,
  );
  const promptCacheHitTarget = normalizeThreshold(
    options.promptCacheHitTarget,
    DEFAULT_PROMPT_CACHE_HIT_TARGET,
  );
  const promptCacheHitStopLossFloor = normalizeThreshold(
    options.promptCacheHitStopLossFloor,
    DEFAULT_PROMPT_CACHE_HIT_STOP_LOSS_FLOOR,
  );
  const baselineUncachedInputTokensPerUsefulTurn = positiveFiniteNumber(
    options.baselineUncachedInputTokensPerUsefulTurn,
  );
  const inputCostRegressionLimit = normalizeThreshold(
    options.inputCostRegressionLimit,
    DEFAULT_INPUT_COST_REGRESSION_LIMIT,
  );
  const samples = readContextEvidenceSamples({
    workspaceRoot: runtime.workspaceRoot,
    sessionIds: options.sessionIds,
  });
  const sessionIdSet = new Set<string>(options.sessionIds ?? []);
  if (!options.sessionIds || options.sessionIds.length === 0) {
    for (const sessionId of runtime.inspect.events.listSessionIds()) {
      sessionIdSet.add(sessionId);
    }
    for (const sample of samples) {
      sessionIdSet.add(sample.sessionId);
    }
  }

  const sessions = [...sessionIdSet]
    .toSorted()
    .map((sessionId): ContextEvidenceSessionReport => {
      const promptSamples = samples.filter(
        (sample): sample is PromptStabilityEvidenceSample =>
          sample.sessionId === sessionId && sample.kind === "prompt_stability",
      );
      const reductionSamples = samples.filter(
        (sample): sample is TransientReductionEvidenceSample =>
          sample.sessionId === sessionId && sample.kind === "transient_reduction",
      );
      const providerCacheSamples = samples.filter(
        (sample): sample is ProviderCacheObservationEvidenceSample =>
          sample.sessionId === sessionId && sample.kind === "provider_cache_observation",
      );
      const latestPrompt = promptSamples.at(-1) ?? null;
      const latestReduction = reductionSamples.at(-1) ?? null;
      const compactionEvents = runtime.inspect.events.query(sessionId, { type: "session_compact" });
      const compactionGeneration = sumCompactionGenerationMetrics(compactionEvents);
      const messageEndEvents = runtime.inspect.events.query(sessionId, { type: "message_end" });
      const messageUsage = sumMessageUsageMetrics(messageEndEvents);
      const firstCompactionTurn =
        compactionEvents
          .map((event) => (typeof event.turn === "number" ? event.turn : null))
          .filter((turn): turn is number => turn !== null)
          .toSorted((left, right) => left - right)[0] ?? null;
      const cost = runtime.inspect.cost.getSummary(sessionId);
      const cacheReadReported = messageEndEvents.some(
        (event) => extractReportedCacheFieldFlags(event.payload).cacheReadReported,
      );
      const cacheWriteReported = messageEndEvents.some(
        (event) => extractReportedCacheFieldFlags(event.payload).cacheWriteReported,
      );
      const cacheAccountingObserved =
        (cacheReadReported || cacheWriteReported) &&
        (cost.cacheReadTokens > 0 || cost.cacheWriteTokens > 0);
      const promptCacheHitRate = ratio(
        messageUsage.cachedInputTokens,
        messageUsage.providerInputTokens,
      );
      const stablePrefixTurns = countScopeAwareStablePrefixTurns(promptSamples);
      const dynamicTailStableTurns = promptSamples.filter((sample) => sample.stableTail).length;
      const reductionCompletedTurns = reductionSamples.filter(
        (sample) => sample.status === "completed",
      ).length;
      const reductionSkippedTurns = reductionSamples.filter(
        (sample) => sample.status === "skipped",
      ).length;
      const totalClearedToolResults = reductionSamples.reduce(
        (sum, sample) => sum + sample.clearedToolResults,
        0,
      );
      const totalClearedChars = reductionSamples.reduce(
        (sum, sample) => sum + sample.clearedChars,
        0,
      );
      const totalEstimatedTokenSavings = reductionSamples.reduce(
        (sum, sample) => sum + sample.estimatedTokenSavings,
        0,
      );
      const completedReductionTurnsBeforeFirstCompaction = reductionSamples.filter(
        (sample) =>
          sample.status === "completed" &&
          firstCompactionTurn !== null &&
          sample.turn < firstCompactionTurn,
      ).length;
      const compactionAdvisedPromptTurns = promptSamples.filter(
        (sample) => sample.compactionAdvised,
      ).length;
      const compactionAdvisedReductionTurns = reductionSamples.filter(
        (sample) => sample.status === "completed" && sample.compactionAdvised,
      ).length;
      const forcedCompactionPromptTurns = promptSamples.filter(
        (sample) => sample.forcedCompaction,
      ).length;
      const forcedCompactionReductionTurns = reductionSamples.filter(
        (sample) => sample.status === "completed" && sample.forcedCompaction,
      ).length;
      const latestProviderCacheEvidence = resolveLatestProviderCacheEvidence(
        providerCacheSamples,
        runtime.inspect.context.getProviderCacheObservation(sessionId),
      );

      return {
        sessionId,
        promptObservedTurns: promptSamples.length,
        stablePrefixTurns,
        stablePrefixRate: ratio(stablePrefixTurns, promptSamples.length),
        dynamicTailStableTurns,
        dynamicTailStableRate: ratio(dynamicTailStableTurns, promptSamples.length),
        latestScopeKey: latestPrompt?.scopeKey ?? null,
        reductionObservedTurns: reductionSamples.length,
        reductionCompletedTurns,
        reductionSkippedTurns,
        totalClearedToolResults,
        totalClearedChars,
        totalEstimatedTokenSavings,
        latestReductionStatus: latestReduction?.status ?? null,
        latestReductionReason: latestReduction?.reason ?? null,
        messageUsageTurns: messageUsage.usefulTurns,
        longSessionEligible: messageUsage.usefulTurns >= longSessionUsefulTurnThreshold,
        uncachedInputTokens: messageUsage.uncachedInputTokens,
        cachedInputTokens: messageUsage.cachedInputTokens,
        providerInputTokens: messageUsage.providerInputTokens,
        outputTokens: messageUsage.outputTokens,
        promptCacheHitRate,
        uncachedInputTokensPerUsefulTurn: ratio(
          messageUsage.uncachedInputTokens,
          messageUsage.usefulTurns,
        ),
        cachedInputTokensPerUsefulTurn: ratio(
          messageUsage.cachedInputTokens,
          messageUsage.usefulTurns,
        ),
        providerInputTokensPerUsefulTurn: ratio(
          messageUsage.providerInputTokens,
          messageUsage.usefulTurns,
        ),
        cacheReadTokens: cost.cacheReadTokens,
        cacheWriteTokens: cost.cacheWriteTokens,
        cacheReadReported,
        cacheWriteReported,
        cacheAccountingObserved,
        compactionEvents: compactionEvents.length,
        compactionGenerationEvents: compactionGeneration.events,
        llmPrimaryCompactionEvents: compactionGeneration.llmPrimaryEvents,
        deterministicEmergencyCompactionEvents: compactionGeneration.deterministicEmergencyEvents,
        compactionGenerationInputTokens: compactionGeneration.inputTokens,
        compactionGenerationOutputTokens: compactionGeneration.outputTokens,
        compactionGenerationCacheReadTokens: compactionGeneration.cacheReadTokens,
        compactionGenerationCacheWriteTokens: compactionGeneration.cacheWriteTokens,
        compactionGenerationTokens: compactionGeneration.totalTokens,
        compactionGenerationCostUsd: compactionGeneration.costUsd,
        compactionGenerationCacheAccountingObserved: compactionGeneration.cacheAccountingObserved,
        firstCompactionTurn,
        completedReductionTurnsBeforeFirstCompaction,
        compactionAdvisedPromptTurns,
        compactionAdvisedReductionTurns,
        forcedCompactionPromptTurns,
        forcedCompactionReductionTurns,
        latestProviderCacheStatus: latestProviderCacheEvidence?.status ?? null,
        latestProviderCacheBreakReason: latestProviderCacheEvidence?.reason ?? null,
        latestProviderCacheUnexpectedBreak: latestProviderCacheEvidence?.unexpectedBreak ?? false,
        latestProviderCacheChangedFields: latestProviderCacheEvidence?.changedFields ?? [],
      };
    })
    .filter(
      (session) =>
        session.promptObservedTurns > 0 ||
        session.reductionObservedTurns > 0 ||
        session.compactionEvents > 0 ||
        session.latestProviderCacheStatus !== null ||
        session.cacheReadReported ||
        session.cacheWriteReported ||
        session.cacheReadTokens > 0 ||
        session.cacheWriteTokens > 0,
    );

  const aggregate: ContextEvidenceAggregateReport = {
    sessionsObserved: sessions.length,
    promptObservedTurns: sessions.reduce((sum, session) => sum + session.promptObservedTurns, 0),
    stablePrefixTurns: sessions.reduce((sum, session) => sum + session.stablePrefixTurns, 0),
    stablePrefixRate: null,
    dynamicTailStableTurns: sessions.reduce(
      (sum, session) => sum + session.dynamicTailStableTurns,
      0,
    ),
    dynamicTailStableRate: null,
    reductionObservedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionObservedTurns,
      0,
    ),
    reductionCompletedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionCompletedTurns,
      0,
    ),
    reductionSkippedTurns: sessions.reduce(
      (sum, session) => sum + session.reductionSkippedTurns,
      0,
    ),
    totalClearedToolResults: sessions.reduce(
      (sum, session) => sum + session.totalClearedToolResults,
      0,
    ),
    totalClearedChars: sessions.reduce((sum, session) => sum + session.totalClearedChars, 0),
    totalEstimatedTokenSavings: sessions.reduce(
      (sum, session) => sum + session.totalEstimatedTokenSavings,
      0,
    ),
    messageUsageTurns: sessions.reduce((sum, session) => sum + session.messageUsageTurns, 0),
    longSessionEligibleSessions: sessions.filter((session) => session.longSessionEligible).length,
    longSessionMessageUsageTurns: sessions
      .filter((session) => session.longSessionEligible)
      .reduce((sum, session) => sum + session.messageUsageTurns, 0),
    totalUncachedInputTokens: sessions.reduce(
      (sum, session) => sum + session.uncachedInputTokens,
      0,
    ),
    totalCachedInputTokens: sessions.reduce((sum, session) => sum + session.cachedInputTokens, 0),
    totalProviderInputTokens: sessions.reduce(
      (sum, session) => sum + session.providerInputTokens,
      0,
    ),
    totalOutputTokens: sessions.reduce((sum, session) => sum + session.outputTokens, 0),
    promptCacheHitRate: null,
    longSessionPromptCacheHitRate: null,
    uncachedInputTokensPerUsefulTurn: null,
    cachedInputTokensPerUsefulTurn: null,
    providerInputTokensPerUsefulTurn: null,
    inputCostRegressionRatio: null,
    totalCacheReadTokens: sessions.reduce((sum, session) => sum + session.cacheReadTokens, 0),
    totalCacheWriteTokens: sessions.reduce((sum, session) => sum + session.cacheWriteTokens, 0),
    sessionsWithReportedCacheRead: sessions.filter((session) => session.cacheReadReported).length,
    sessionsWithReportedCacheWrite: sessions.filter((session) => session.cacheWriteReported).length,
    sessionsWithObservedCacheAccounting: sessions.filter(
      (session) => session.cacheAccountingObserved,
    ).length,
    totalCompactionEvents: sessions.reduce((sum, session) => sum + session.compactionEvents, 0),
    totalCompactionGenerationEvents: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationEvents,
      0,
    ),
    totalLlmPrimaryCompactionEvents: sessions.reduce(
      (sum, session) => sum + session.llmPrimaryCompactionEvents,
      0,
    ),
    totalDeterministicEmergencyCompactionEvents: sessions.reduce(
      (sum, session) => sum + session.deterministicEmergencyCompactionEvents,
      0,
    ),
    totalCompactionGenerationInputTokens: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationInputTokens,
      0,
    ),
    totalCompactionGenerationOutputTokens: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationOutputTokens,
      0,
    ),
    totalCompactionGenerationCacheReadTokens: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationCacheReadTokens,
      0,
    ),
    totalCompactionGenerationCacheWriteTokens: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationCacheWriteTokens,
      0,
    ),
    totalCompactionGenerationTokens: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationTokens,
      0,
    ),
    totalCompactionGenerationCostUsd: sessions.reduce(
      (sum, session) => sum + session.compactionGenerationCostUsd,
      0,
    ),
    sessionsWithCompactionGenerationCacheAccounting: sessions.filter(
      (session) => session.compactionGenerationCacheAccountingObserved,
    ).length,
    sessionsMeetingStablePrefixTarget: sessions.filter(
      (session) => (session.stablePrefixRate ?? 0) >= 0.95,
    ).length,
    sessionsWithCompletedReduction: sessions.filter(
      (session) => session.reductionCompletedTurns > 0,
    ).length,
    sessionsWithReductionBeforeCompaction: sessions.filter(
      (session) => session.completedReductionTurnsBeforeFirstCompaction > 0,
    ).length,
    sessionsWithCompletedReductionAndNoCompaction: sessions.filter(
      (session) => session.reductionCompletedTurns > 0 && session.compactionEvents === 0,
    ).length,
    providerCacheBreakObservedSessions: sessions.filter(
      (session) => session.latestProviderCacheStatus === "break",
    ).length,
    providerCacheUnexpectedBreakSessions: sessions.filter(
      (session) => session.latestProviderCacheUnexpectedBreak,
    ).length,
    providerCacheTtlExpiryBreakSessions: sessions.filter((session) =>
      isTtlProviderCacheBreakReason(session.latestProviderCacheBreakReason),
    ).length,
    providerCacheBreakReasonCounts: countByString(
      sessions.flatMap((session) =>
        session.latestProviderCacheBreakReason === null
          ? []
          : [session.latestProviderCacheBreakReason],
      ),
    ),
    providerCacheChangedFieldCounts: countByString(
      sessions.flatMap((session) => session.latestProviderCacheChangedFields),
    ),
  };
  aggregate.stablePrefixRate = ratio(aggregate.stablePrefixTurns, aggregate.promptObservedTurns);
  aggregate.dynamicTailStableRate = ratio(
    aggregate.dynamicTailStableTurns,
    aggregate.promptObservedTurns,
  );
  aggregate.promptCacheHitRate = ratio(
    aggregate.totalCachedInputTokens,
    aggregate.totalProviderInputTokens,
  );
  const longSessionSessions = sessions.filter((session) => session.longSessionEligible);
  aggregate.longSessionPromptCacheHitRate = ratio(
    longSessionSessions.reduce((sum, session) => sum + session.cachedInputTokens, 0),
    longSessionSessions.reduce((sum, session) => sum + session.providerInputTokens, 0),
  );
  aggregate.uncachedInputTokensPerUsefulTurn = ratio(
    aggregate.totalUncachedInputTokens,
    aggregate.messageUsageTurns,
  );
  aggregate.cachedInputTokensPerUsefulTurn = ratio(
    aggregate.totalCachedInputTokens,
    aggregate.messageUsageTurns,
  );
  aggregate.providerInputTokensPerUsefulTurn = ratio(
    aggregate.totalProviderInputTokens,
    aggregate.messageUsageTurns,
  );
  aggregate.inputCostRegressionRatio =
    baselineUncachedInputTokensPerUsefulTurn && aggregate.uncachedInputTokensPerUsefulTurn !== null
      ? (aggregate.uncachedInputTokensPerUsefulTurn - baselineUncachedInputTokensPerUsefulTurn) /
        baselineUncachedInputTokensPerUsefulTurn
      : null;

  const promotionReadiness: ContextEvidencePromotionReadiness = {
    stablePrefixTargetMet: (aggregate.stablePrefixRate ?? 0) >= 0.95,
    reductionEvidenceObserved:
      aggregate.reductionCompletedTurns > 0 &&
      aggregate.totalEstimatedTokenSavings > 0 &&
      (aggregate.sessionsWithReductionBeforeCompaction > 0 ||
        aggregate.sessionsWithCompletedReductionAndNoCompaction > 0),
    cacheAccountingObserved: aggregate.sessionsWithObservedCacheAccounting > 0,
    promptCacheHitTargetMet:
      aggregate.longSessionEligibleSessions === 0 ||
      (aggregate.longSessionPromptCacheHitRate ?? 0) >= promptCacheHitTarget,
    promptCacheStopLossPassed:
      aggregate.longSessionEligibleSessions === 0 ||
      (aggregate.longSessionPromptCacheHitRate ?? 0) >= promptCacheHitStopLossFloor,
    inputCostBaselineObserved: baselineUncachedInputTokensPerUsefulTurn !== null,
    inputCostStopLossPassed:
      aggregate.inputCostRegressionRatio === null ||
      aggregate.inputCostRegressionRatio <= inputCostRegressionLimit,
    ready: false,
    gaps: [],
  };
  if (!promotionReadiness.stablePrefixTargetMet) {
    promotionReadiness.gaps.push("stable_prefix_below_target");
  }
  if (!promotionReadiness.reductionEvidenceObserved) {
    promotionReadiness.gaps.push("transient_reduction_deferral_evidence_missing");
  }
  if (!promotionReadiness.cacheAccountingObserved) {
    promotionReadiness.gaps.push("cache_accounting_missing");
  }
  if (!promotionReadiness.promptCacheStopLossPassed) {
    promotionReadiness.gaps.push("prompt_cache_hit_stop_loss_failed");
  }
  if (!promotionReadiness.inputCostStopLossPassed) {
    promotionReadiness.gaps.push("input_cost_regression_stop_loss_failed");
  }
  promotionReadiness.ready = promotionReadiness.gaps.length === 0;

  return {
    schema: CONTEXT_EVIDENCE_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    workspaceRoot: runtime.workspaceRoot,
    sessionIds: sessions.map((session) => session.sessionId),
    aggregate,
    promotionReadiness,
    sessions,
  };
}

export function persistContextEvidenceReport(input: {
  workspaceRoot: string;
  report: ContextEvidenceReport;
}): ContextEvidenceArtifactRef {
  const absolutePath = resolve(resolveEvidenceDir(input.workspaceRoot), REPORT_FILE_NAME);
  ensureParentDirectory(absolutePath);
  writeFileSync(absolutePath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8");
  return {
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    absolutePath,
  };
}
