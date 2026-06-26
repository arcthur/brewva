import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { getModels, resolveCacheCostMultipliers } from "@brewva/brewva-provider-core/catalog";
import type { KnownProvider } from "@brewva/brewva-provider-core/contracts";
import { isRecord } from "@brewva/brewva-std/unknown";
import { computeNetReuseValue, type NetReuseInputs } from "@brewva/brewva-substrate/context-budget";
import { RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND } from "@brewva/brewva-vocabulary/events";
import { MODEL_SELECT_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { MESSAGE_END_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  getRuntimeContextEvidenceLatest,
  getRuntimeCostSummary,
  listRuntimeEventSessionIds,
  queryRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "../../session/runtime-ports.js";
import {
  ensureParentDirectory,
  normalizeRelativePath,
  readContextEvidenceSamples,
  resolveEvidenceDir,
} from "./context-evidence/store.js";
import {
  CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
  CONTEXT_EVIDENCE_REPORT_SCHEMA,
  type ContextEvidenceAggregateReport,
  type ContextEvidenceArtifactRef,
  type ContextEvidenceEconomicVerdict,
  type ContextEvidenceEconomicVerdictKind,
  type ContextEvidenceVerdictSource,
  type ContextEvidenceVerdictGrade,
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
  ContextEvidenceEconomicVerdict,
  ContextEvidenceEconomicVerdictKind,
  ContextEvidencePromotionReadiness,
  ContextEvidenceReport,
  ContextEvidenceReportOptions,
  ContextEvidenceSample,
  ContextEvidenceSessionReport,
  PromptStabilityEvidenceSample,
  ProviderCacheObservationEvidenceSample,
  TransientReductionEvidenceSample,
} from "./context-evidence/types.js";

export { CONTEXT_EVIDENCE_SAMPLE_SCHEMA };

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
const CACHE_REGRESSION_ABSOLUTE_MISS_RATIO_DELTA = 0.15;
const CACHE_REGRESSION_RELATIVE_MISS_RATIO_DELTA = 0.25;
// Phase 1 conservative default for R (expected suffix reads before TTL lapse).
// Open question in the RFC: may later derive from observed inter-turn cadence.
const DEFAULT_EXPECTED_SUFFIX_READS = 10;
const CONTINUATION_ANCHOR_FOLLOWUP_WINDOW_MS = 5 * 60 * 1000;
const CONTINUATION_ANCHOR_FOLLOWUP_WINDOW_TURNS = 2;

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
  if (!isRecord(payload)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  const usage = payload.usage;
  if (!isRecord(usage)) {
    return {
      cacheReadReported: false,
      cacheWriteReported: false,
    };
  }

  return {
    cacheReadReported: usage.cacheReadReported === true,
    cacheWriteReported: usage.cacheWriteReported === true,
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
  if (!isRecord(payload)) {
    return metrics;
  }
  if (typeof payload.role === "string" && payload.role !== "assistant") {
    return metrics;
  }
  if (payload.stopReason === "error" || payload.stopReason === "aborted") {
    return metrics;
  }
  if (!isRecord(payload.usage)) {
    return metrics;
  }

  const usage = payload.usage;
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
  workbenchPrimaryEvents: number;
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
    workbenchPrimaryEvents: 0,
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
  if (!isRecord(payload)) {
    return metrics;
  }

  const summaryGeneration = payload.summaryGeneration;
  if (!isRecord(summaryGeneration)) {
    return metrics;
  }

  if (
    typeof summaryGeneration.strategy !== "string" ||
    summaryGeneration.strategy.trim().length === 0
  ) {
    return metrics;
  }

  metrics.events = 1;
  if (summaryGeneration.strategy === "llm_primary_compaction") {
    metrics.llmPrimaryEvents = 1;
  }
  if (summaryGeneration.strategy === "workbench_primary_compaction") {
    metrics.workbenchPrimaryEvents = 1;
  }
  if (summaryGeneration.strategy === "deterministic_emergency_compaction") {
    metrics.deterministicEmergencyEvents = 1;
  }

  if (!isRecord(summaryGeneration.usage)) {
    return metrics;
  }

  const usage = summaryGeneration.usage;
  metrics.inputTokens = readNonNegativeFiniteNumber(usage.input);
  metrics.outputTokens = readNonNegativeFiniteNumber(usage.output);
  metrics.cacheReadTokens = readNonNegativeFiniteNumber(usage.cacheRead);
  metrics.cacheWriteTokens = readNonNegativeFiniteNumber(usage.cacheWrite);
  metrics.totalTokens =
    readNonNegativeFiniteNumber(usage.totalTokens) ||
    metrics.inputTokens + metrics.outputTokens + metrics.cacheWriteTokens;
  metrics.costUsd = isRecord(usage.cost) ? readNonNegativeFiniteNumber(usage.cost.total) : 0;
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
      workbenchPrimaryEvents: sum.workbenchPrimaryEvents + current.workbenchPrimaryEvents,
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

interface CacheImpactSnapshotMetrics {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface CacheImpactMetrics {
  before: CacheImpactSnapshotMetrics | null;
  after: CacheImpactSnapshotMetrics | null;
  explicitEpochChanges: number;
  prefixBytesChanged: number | null;
}

function readCacheImpactSnapshotMetrics(value: unknown): CacheImpactSnapshotMetrics | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    cacheReadTokens: readNonNegativeFiniteNumber(value.cacheReadTokens),
    cacheWriteTokens: readNonNegativeFiniteNumber(value.cacheWriteTokens),
  };
}

function readCacheImpactMetrics(payload: unknown): CacheImpactMetrics | null {
  if (!isRecord(payload) || !isRecord(payload.cacheImpact)) {
    return null;
  }
  const cacheImpact = payload.cacheImpact;
  return {
    before: readCacheImpactSnapshotMetrics(cacheImpact.before),
    after: readCacheImpactSnapshotMetrics(cacheImpact.after),
    explicitEpochChanges: readNonNegativeFiniteNumber(cacheImpact.explicitEpochChanges),
    prefixBytesChanged:
      typeof cacheImpact.prefixBytesChanged === "number" &&
      Number.isFinite(cacheImpact.prefixBytesChanged)
        ? cacheImpact.prefixBytesChanged
        : null,
  };
}

function cacheMissRatio(snapshot: CacheImpactSnapshotMetrics | null): number | null {
  if (!snapshot) {
    return null;
  }
  return ratio(snapshot.cacheWriteTokens, snapshot.cacheReadTokens + snapshot.cacheWriteTokens);
}

interface CacheCostMultipliers {
  writeMultiplier: number;
  readMultiplier: number;
}

function readFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Phase 1: compute a per-compaction net-reuse value (headroom's #856 model, pure)
// from the committed payload. Both inputs derive from already-recorded fields, so
// every commit path (controller, replay) is covered without a new recorded
// quantity: dT = fromTokens - toTokens (tokens freed), and S = toTokens (the
// retained post-compaction context that re-caches under the changed prefix).
// Returns null inputs/value when pricing or the token counts are absent, so
// missing data never fabricates a number.
function readCompactionNetReuse(
  payload: unknown,
  multipliers: CacheCostMultipliers | null,
  expectedReads: number,
): { compactId?: string; netReuseValue: number | null; netReuseInputs: NetReuseInputs | null } {
  const record = isRecord(payload) ? payload : null;
  const compactId =
    record && typeof record.compactId === "string" && record.compactId.length > 0
      ? record.compactId
      : undefined;
  const base = compactId ? { compactId } : {};
  if (!record || !multipliers) {
    return { ...base, netReuseValue: null, netReuseInputs: null };
  }
  const fromTokens = readFiniteOrNull(record.fromTokens);
  const toTokens = readFiniteOrNull(record.toTokens);
  if (fromTokens === null || toTokens === null) {
    return { ...base, netReuseValue: null, netReuseInputs: null };
  }
  const estimate = computeNetReuseValue({
    deltaTokens: fromTokens - toTokens,
    suffixTokens: toTokens,
    writeMultiplier: multipliers.writeMultiplier,
    readMultiplier: multipliers.readMultiplier,
    expectedReads,
    pAlive: 1, // Phase 1: conservative full penalty; idle-decay is deferred to Loop 3.
  });
  return {
    ...base,
    netReuseValue: estimate?.netReuseValue ?? null,
    netReuseInputs: estimate?.inputs ?? null,
  };
}

function verdictSource(
  kind: ContextEvidenceEconomicVerdictKind,
  compactId?: string,
  observation?: ProviderCacheObservationEvidenceSample | null,
): ContextEvidenceVerdictSource {
  return {
    kind,
    ...(compactId ? { compactId } : {}),
    ...(observation
      ? {
          observationTurn: observation.turn,
          observationStatus: observation.status as "cold" | "warm" | "break",
          observationExpected: observation.expected,
          observationReason: observation.reason,
        }
      : {}),
  };
}

// An observation is informative only when it carries a real cache outcome
// (cold/warm/break). `limited` means cache accounting was unavailable, so it
// neither confirms nor refutes — it must not promote a verdict to `measured`.
function informativeObservation(
  observation: ProviderCacheObservationEvidenceSample | null,
): ProviderCacheObservationEvidenceSample | null {
  return observation && observation.status !== "limited" ? observation : null;
}

// Honesty grade (axiom 7): an informative post-compaction observation makes the
// verdict `measured` (confirm or refute is recorded in the source); a resolved
// economic prediction alone is `estimated`; neither is `inconclusive`.
function gradeEconomicVerdict(
  netReuseValue: number | null,
  observation: ProviderCacheObservationEvidenceSample | null,
): ContextEvidenceVerdictGrade {
  if (observation) {
    return "measured";
  }
  return netReuseValue !== null ? "estimated" : "inconclusive";
}

export function buildCompactionEconomicVerdicts(input: {
  compactionEvents: readonly { payload?: unknown; timestamp?: number }[];
  // Pricing is resolved per compaction at its own timestamp, so a mid-session
  // model change does not reprice older compactions.
  cacheCostMultipliersAt?: (timestamp: number | undefined) => CacheCostMultipliers | null;
  expectedSuffixReads?: number;
  providerCacheSamples?: readonly ProviderCacheObservationEvidenceSample[];
}): ContextEvidenceEconomicVerdict[] {
  const resolveMultipliers = input.cacheCostMultipliersAt ?? (() => null);
  const expectedReads = input.expectedSuffixReads ?? DEFAULT_EXPECTED_SUFFIX_READS;
  const providerCacheSamples = input.providerCacheSamples ?? [];
  // Verdicts are per-cut, not per-kind: one compaction may yield several kinds,
  // and several compactions may each yield the same kind. Dedup receipts by
  // compactId so a single compaction surfacing as both a legacy and a committed
  // event is not double-counted; the verdict identity is compactId + kind.
  const verdicts: ContextEvidenceEconomicVerdict[] = [];
  const seenCompactIds = new Set<string>();

  for (const event of input.compactionEvents) {
    const compactId = readCompactIdPayload(event.payload);
    if (compactId) {
      if (seenCompactIds.has(compactId)) {
        continue;
      }
      seenCompactIds.add(compactId);
    }
    const multipliers = resolveMultipliers(event.timestamp);
    const netReuse = readCompactionNetReuse(event.payload, multipliers, expectedReads);
    const observation = informativeObservation(
      typeof event.timestamp === "number"
        ? nextProviderCacheSampleAfter(providerCacheSamples, event.timestamp)
        : null,
    );
    const grade = gradeEconomicVerdict(netReuse.netReuseValue, observation);
    const source = (kind: ContextEvidenceEconomicVerdictKind): ContextEvidenceVerdictSource =>
      verdictSource(kind, netReuse.compactId, observation);

    // Phase 3: wasteful is the per-cut economic verdict — the cut freed less cache
    // value than it cost to rebuild the suffix. It depends only on the net-reuse
    // economics, not on cache-impact evidence, so it is evaluated independently.
    if (netReuse.netReuseValue !== null && netReuse.netReuseValue < 0) {
      verdicts.push({
        kind: "wasteful",
        reason: "compaction freed less cache value than it cost to rebuild the suffix",
        metrics: {
          netReuseValue: netReuse.netReuseValue,
          deltaTokens: netReuse.netReuseInputs?.deltaTokens ?? null,
          suffixTokens: netReuse.netReuseInputs?.suffixTokens ?? null,
        },
        source: source("wasteful"),
        netReuseValue: netReuse.netReuseValue,
        netReuseInputs: netReuse.netReuseInputs,
        grade,
      });
    }

    // Cache-impact-derived verdicts only apply when cache-impact evidence exists.
    const cacheImpact = readCacheImpactMetrics(event.payload);
    if (!cacheImpact) {
      continue;
    }
    const beforeMissRatio = cacheMissRatio(cacheImpact.before);
    const afterMissRatio = cacheMissRatio(cacheImpact.after);
    if (beforeMissRatio !== null && afterMissRatio !== null) {
      const absoluteDelta = afterMissRatio - beforeMissRatio;
      const relativeDelta = beforeMissRatio > 0 ? absoluteDelta / beforeMissRatio : null;
      if (
        absoluteDelta > CACHE_REGRESSION_ABSOLUTE_MISS_RATIO_DELTA ||
        (relativeDelta !== null && relativeDelta > CACHE_REGRESSION_RELATIVE_MISS_RATIO_DELTA)
      ) {
        verdicts.push({
          kind: "cache_regression",
          reason: "prefix cache miss ratio regressed after compaction",
          metrics: {
            beforeMissRatio,
            afterMissRatio,
            absoluteDelta,
            relativeDelta,
          },
          source: source("cache_regression"),
          netReuseValue: netReuse.netReuseValue,
          netReuseInputs: netReuse.netReuseInputs,
          grade,
        });
      }
    }
    if (cacheImpact.explicitEpochChanges > 1 && cacheImpact.prefixBytesChanged === null) {
      verdicts.push({
        kind: "unaccounted_break",
        reason: "explicit cache epoch changed without changed prefix byte evidence",
        metrics: {
          explicitEpochChanges: cacheImpact.explicitEpochChanges,
          prefixBytesChanged: null,
        },
        source: source("unaccounted_break"),
        netReuseValue: netReuse.netReuseValue,
        netReuseInputs: netReuse.netReuseInputs,
        grade,
      });
    }
  }

  return verdicts.toSorted(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      (left.source?.compactId ?? "").localeCompare(right.source?.compactId ?? ""),
  );
}

export interface CacheCostBasis {
  readonly atTimestamp: number;
  readonly multipliers: CacheCostMultipliers;
}

// A session's model-pricing timeline: each model_select resolved to its cache
// multipliers, ascending by timestamp. w/r are price weights from the model
// catalog, never inferred from token volumes; unresolvable models are skipped.
function buildSessionCacheCostTimeline(
  runtime: Pick<HostedRuntimeAdapterPort, "ops">,
  sessionId: string,
): CacheCostBasis[] {
  const timeline: CacheCostBasis[] = [];
  for (const event of queryRuntimeEvents(runtime, sessionId, { type: MODEL_SELECT_EVENT_TYPE })) {
    if (!isRecord(event.payload) || typeof event.timestamp !== "number") {
      continue;
    }
    const { provider, model } = event.payload;
    if (typeof provider !== "string" || typeof model !== "string") {
      continue;
    }
    const resolved = getModels(provider as KnownProvider).find((entry) => entry.id === model);
    const multipliers = resolved ? resolveCacheCostMultipliers(resolved.cost) : null;
    if (multipliers) {
      timeline.push({ atTimestamp: event.timestamp, multipliers });
    }
  }
  return timeline.toSorted((left, right) => left.atTimestamp - right.atTimestamp);
}

/**
 * Resolve the pricing active at a given timestamp — the latest model_select at or
 * before it. A compaction before any model_select has no basis (null); when the
 * timestamp is unknown the most recent basis is the best available fallback.
 */
export function resolvePricingFromTimeline(
  timeline: readonly CacheCostBasis[],
  timestamp: number | undefined,
): CacheCostMultipliers | null {
  if (timeline.length === 0) {
    return null;
  }
  if (typeof timestamp !== "number") {
    return timeline[timeline.length - 1]!.multipliers;
  }
  let active: CacheCostMultipliers | null = null;
  for (const basis of timeline) {
    if (basis.atTimestamp <= timestamp) {
      active = basis.multipliers;
    } else {
      break;
    }
  }
  return active;
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function projectProviderCacheEvidencePayload(
  observation:
    | {
        turn: number;
        timestamp: number;
        payload: Record<string, unknown>;
      }
    | undefined,
): ProviderCacheEvidenceProjection | null {
  if (!observation) {
    return null;
  }
  const status = readString(observation.payload.status);
  if (status !== "cold" && status !== "warm" && status !== "break" && status !== "limited") {
    return null;
  }
  const expected = observation.payload.expected === true;
  return {
    timestamp: observation.timestamp,
    turn: observation.turn,
    status,
    reason: readString(observation.payload.reason),
    unexpectedBreak: status === "break" && !expected,
    changedFields: readStringArray(observation.payload.changedFields),
  };
}

function resolveLatestProviderCacheEvidence(
  samples: readonly ProviderCacheObservationEvidenceSample[],
  liveObservation:
    | {
        turn: number;
        timestamp: number;
        payload: Record<string, unknown>;
      }
    | undefined,
): ProviderCacheEvidenceProjection | null {
  const liveProjection = projectProviderCacheEvidencePayload(liveObservation);
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

interface RuntimeEventProjection {
  id: string | null;
  type: string;
  timestamp: number;
  turn: number | null;
  payload?: unknown;
}

function nextProviderCacheSampleAfter(
  samples: readonly ProviderCacheObservationEvidenceSample[],
  timestamp: number,
): ProviderCacheObservationEvidenceSample | null {
  let next: ProviderCacheObservationEvidenceSample | null = null;
  for (const sample of samples) {
    if (sample.timestamp <= timestamp) {
      continue;
    }
    if (!next || sample.timestamp < next.timestamp) {
      next = sample;
    }
  }
  return next;
}

function correlateExpectedCacheBreaks(
  reductionSamples: readonly TransientReductionEvidenceSample[],
  cacheSamples: readonly ProviderCacheObservationEvidenceSample[],
): { expected: number; confirmed: number; unconfirmed: number } {
  let expected = 0;
  let confirmed = 0;
  let unconfirmed = 0;
  for (const sample of reductionSamples) {
    if (!sample.expectedCacheBreak) {
      continue;
    }
    expected += 1;
    const next = nextProviderCacheSampleAfter(cacheSamples, sample.timestamp);
    if (!next) {
      continue;
    }
    if (next.status === "break" || next.status === "cold") {
      confirmed += 1;
    } else if (next.status === "warm") {
      unconfirmed += 1;
    }
  }
  return { expected, confirmed, unconfirmed };
}

function readCompactIdPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const compactId = (payload as { compactId?: unknown }).compactId;
  return typeof compactId === "string" && compactId.length > 0 ? compactId : null;
}

/**
 * Post-compaction cache metrics are derived from committed session_compact
 * receipts only, deduplicated by compactId so one compaction maps to exactly
 * one correlation even when the receipt surfaces through multiple event kinds.
 */
function dedupeCompactionReceiptEvents(
  events: readonly RuntimeEventProjection[],
): RuntimeEventProjection[] {
  const seen = new Set<string>();
  const unique: RuntimeEventProjection[] = [];
  for (const event of events) {
    const key =
      readCompactIdPayload(event.payload) ?? event.id ?? `${event.type}:${event.timestamp}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

function correlatePostCompactionCacheObservations(
  compactionReceipts: readonly RuntimeEventProjection[],
  cacheSamples: readonly ProviderCacheObservationEvidenceSample[],
): { observed: number; warm: number; reset: number } {
  let observed = 0;
  let warm = 0;
  let reset = 0;
  for (const signal of compactionReceipts) {
    const next = nextProviderCacheSampleAfter(cacheSamples, signal.timestamp);
    if (!next) {
      continue;
    }
    observed += 1;
    if (next.status === "warm") {
      warm += 1;
    } else if (next.status === "break" || next.status === "cold") {
      reset += 1;
    }
  }
  return { observed, warm, reset };
}

function projectRuntimeEvent(event: {
  id?: unknown;
  type?: unknown;
  timestamp?: unknown;
  turn?: unknown;
  payload?: unknown;
}): RuntimeEventProjection | null {
  if (typeof event.type !== "string") {
    return null;
  }
  const timestamp =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : 0;
  const turn =
    typeof event.turn === "number" && Number.isFinite(event.turn) ? Math.trunc(event.turn) : null;
  return {
    id: typeof event.id === "string" && event.id.length > 0 ? event.id : null,
    type: event.type,
    timestamp,
    turn,
    payload: event.payload,
  };
}

function uniqueRuntimeEvents(events: readonly RuntimeEventProjection[]): RuntimeEventProjection[] {
  const seen = new Set<string>();
  const unique: RuntimeEventProjection[] = [];
  for (const event of events) {
    const key =
      event.id ??
      `${event.type}:${event.timestamp}:${event.turn ?? "none"}:${JSON.stringify(event.payload)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

function latestPromptSampleAtOrBeforeAnchor(
  promptSamples: readonly PromptStabilityEvidenceSample[],
  anchor: RuntimeEventProjection,
): PromptStabilityEvidenceSample | null {
  return (
    promptSamples
      .filter((sample) => {
        if (anchor.turn !== null) {
          return sample.turn <= anchor.turn;
        }
        return sample.timestamp <= anchor.timestamp;
      })
      .toSorted((left, right) => {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp - right.timestamp;
        }
        return left.turn - right.turn;
      })
      .at(-1) ?? null
  );
}

function hasPressure(sample: PromptStabilityEvidenceSample | null): boolean {
  if (!sample) {
    return false;
  }
  return (
    sample.compactionAdvised ||
    sample.forcedCompaction ||
    sample.gateRequired ||
    sample.pendingCompactionReason !== null
  );
}

function isCompactionRequiredEvent(event: RuntimeEventProjection): boolean {
  if (event.type === "compaction_required") {
    return true;
  }
  if (!isRecord(event.payload)) {
    return false;
  }
  return event.type === "checkpoint.committed" && event.payload.cause === "compaction_required";
}

function isFollowupCompactionEvent(input: {
  anchor: RuntimeEventProjection;
  event: RuntimeEventProjection;
}): boolean {
  if (input.event.timestamp < input.anchor.timestamp) {
    return false;
  }
  if (input.anchor.turn !== null && input.event.turn !== null) {
    return (
      input.event.turn >= input.anchor.turn &&
      input.event.turn - input.anchor.turn <= CONTINUATION_ANCHOR_FOLLOWUP_WINDOW_TURNS
    );
  }
  return input.event.timestamp - input.anchor.timestamp <= CONTINUATION_ANCHOR_FOLLOWUP_WINDOW_MS;
}

function countContinuationAnchorsFollowedByCompaction(input: {
  anchors: readonly RuntimeEventProjection[];
  compactionSignals: readonly RuntimeEventProjection[];
}): number {
  return input.anchors.filter((anchor) =>
    input.compactionSignals.some((event) => isFollowupCompactionEvent({ anchor, event })),
  ).length;
}

const RECOMMENDATION_SCHEMA = "brewva.context-evidence.recommendation.v1" as const;
const DEFAULT_RECOMMENDATION_MIN_SAMPLE_SIZE = 10;
const DEFAULT_RECOMMENDATION_RESET_RATIO_REVIEW_THRESHOLD = 0.5;

export interface ContextEvidenceRecommendationInput {
  /** Post-compaction observations whose provider cache stayed warm. */
  readonly warm: number;
  /** Post-compaction observations whose provider cache reset. */
  readonly reset: number;
  readonly advisoryRatio: number;
  readonly hardRatio: number;
  readonly tailProtectRatio: number;
  readonly minSampleSize?: number;
  readonly resetRatioReviewThreshold?: number;
}

export interface ContextEvidenceRecommendation {
  readonly schema: typeof RECOMMENDATION_SCHEMA;
  readonly sampleSize: number;
  readonly observedCacheResetRatio: number | null;
  readonly currentAdvisoryRatio: number;
  readonly currentHardRatio: number;
  readonly currentTailProtectRatio: number;
  readonly posture: "hold" | "review" | "insufficient_evidence";
  readonly rationale: string;
}

/**
 * Pure, conservative evidence-fit recommendation derived from the report's
 * post-compaction cache warm/reset counts and the live config ratios. It never
 * auto-applies and never fabricates a target ratio: it reports the observed reset
 * ratio against the current ratios with a `hold` / `review` / `insufficient_evidence`
 * posture so an operator can decide a reviewed config edit. Per-model breakdown and
 * a specific recommended ratio are intentionally out of scope — cache observations
 * do not yet carry a model id (see the RFC Open Questions).
 */
export function deriveContextEvidenceRecommendation(
  input: ContextEvidenceRecommendationInput,
): ContextEvidenceRecommendation {
  const warm = Math.max(0, Math.trunc(input.warm));
  const reset = Math.max(0, Math.trunc(input.reset));
  const sampleSize = warm + reset;
  const observedCacheResetRatio = sampleSize > 0 ? reset / sampleSize : null;
  const minSampleSize =
    typeof input.minSampleSize === "number" && input.minSampleSize > 0
      ? Math.trunc(input.minSampleSize)
      : DEFAULT_RECOMMENDATION_MIN_SAMPLE_SIZE;
  const reviewThreshold =
    typeof input.resetRatioReviewThreshold === "number" &&
    input.resetRatioReviewThreshold >= 0 &&
    input.resetRatioReviewThreshold <= 1
      ? input.resetRatioReviewThreshold
      : DEFAULT_RECOMMENDATION_RESET_RATIO_REVIEW_THRESHOLD;

  const base: Omit<ContextEvidenceRecommendation, "posture" | "rationale"> = {
    schema: RECOMMENDATION_SCHEMA,
    sampleSize,
    observedCacheResetRatio,
    currentAdvisoryRatio: input.advisoryRatio,
    currentHardRatio: input.hardRatio,
    currentTailProtectRatio: input.tailProtectRatio,
  };

  if (observedCacheResetRatio === null || sampleSize < minSampleSize) {
    return {
      ...base,
      posture: "insufficient_evidence",
      rationale: `Need at least ${minSampleSize} post-compaction cache observations before recommending a change; observed ${sampleSize}.`,
    };
  }
  if (observedCacheResetRatio >= reviewThreshold) {
    return {
      ...base,
      posture: "review",
      rationale: `Compaction reset the provider cache in ${(observedCacheResetRatio * 100).toFixed(0)}% of ${sampleSize} observations (>= ${(reviewThreshold * 100).toFixed(0)}% review threshold); review advisoryRatio/minTurnsBetween to compact on a more cache-stable boundary, then adopt any change as a reviewed config edit.`,
    };
  }
  return {
    ...base,
    posture: "hold",
    rationale: `Post-compaction cache stayed warm in ${((1 - observedCacheResetRatio) * 100).toFixed(0)}% of ${sampleSize} observations; current ratios look healthy.`,
  };
}

export function buildContextEvidenceReport(
  runtime: Pick<HostedRuntimeAdapterPort, "identity" | "ops">,
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
    workspaceRoot: runtime.identity.workspaceRoot,
    sessionIds: options.sessionIds,
  });
  const sessionIdSet = new Set<string>(options.sessionIds ?? []);
  if (!options.sessionIds || options.sessionIds.length === 0) {
    for (const sessionId of listRuntimeEventSessionIds(runtime)) {
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
      const legacyCompactionEvents = queryRuntimeEvents(runtime, sessionId, {
        type: "session_compact",
      });
      const committedCompactionEvents = queryRuntimeEvents(runtime, sessionId, {
        type: RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND,
      });
      const compactionEvents = [...legacyCompactionEvents, ...committedCompactionEvents];
      const continuationAnchorEvents = queryRuntimeEvents(runtime, sessionId, {
        type: "tape.handoff",
      })
        .map((event) => projectRuntimeEvent(event))
        .filter((event): event is RuntimeEventProjection => event !== null);
      const uniqueContinuationAnchorEvents = uniqueRuntimeEvents(continuationAnchorEvents);
      const runtimeEventProjections = queryRuntimeEvents(runtime, sessionId)
        .map((event) => projectRuntimeEvent(event))
        .filter((event): event is RuntimeEventProjection => event !== null);
      const compactionSignals = [
        ...compactionEvents
          .map((event) => projectRuntimeEvent(event))
          .filter((event): event is RuntimeEventProjection => event !== null),
        ...runtimeEventProjections.filter((event) => isCompactionRequiredEvent(event)),
      ];
      const continuationAnchorPressureSamples = uniqueContinuationAnchorEvents.map((anchor) =>
        latestPromptSampleAtOrBeforeAnchor(promptSamples, anchor),
      );
      const continuationAnchorsWithPressureEvidence =
        continuationAnchorPressureSamples.filter(Boolean).length;
      const continuationAnchorsDuringPressure = continuationAnchorPressureSamples.filter((sample) =>
        hasPressure(sample),
      ).length;
      const continuationAnchorsFollowedByCompaction = countContinuationAnchorsFollowedByCompaction({
        anchors: uniqueContinuationAnchorEvents,
        compactionSignals,
      });
      const compactionGeneration = sumCompactionGenerationMetrics(compactionEvents);
      const messageEndEvents = queryRuntimeEvents(runtime, sessionId, {
        type: MESSAGE_END_EVENT_TYPE,
      });
      const messageUsage = sumMessageUsageMetrics(messageEndEvents);
      const firstCompactionTurn =
        compactionEvents
          .map((event) => (typeof event.turn === "number" ? event.turn : null))
          .filter((turn): turn is number => turn !== null)
          .toSorted((left, right) => left - right)[0] ?? null;
      const cost = getRuntimeCostSummary(runtime, sessionId);
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
        getRuntimeContextEvidenceLatest(runtime, sessionId, "provider_cache_observation"),
      );
      const expectedCacheBreakCorrelation = correlateExpectedCacheBreaks(
        reductionSamples,
        providerCacheSamples,
      );
      const postCompactionCache = correlatePostCompactionCacheObservations(
        dedupeCompactionReceiptEvents(
          [...committedCompactionEvents, ...legacyCompactionEvents]
            .map((event) => projectRuntimeEvent(event))
            .filter((event): event is RuntimeEventProjection => event !== null),
        ),
        providerCacheSamples,
      );
      const cacheCostTimeline = buildSessionCacheCostTimeline(runtime, sessionId);
      const economicVerdicts = buildCompactionEconomicVerdicts({
        compactionEvents,
        cacheCostMultipliersAt: (timestamp) =>
          resolvePricingFromTimeline(cacheCostTimeline, timestamp),
        providerCacheSamples,
      });

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
        workbenchPrimaryCompactionEvents: compactionGeneration.workbenchPrimaryEvents,
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
        continuationAnchorEvents: uniqueContinuationAnchorEvents.length,
        continuationAnchorsWithPressureEvidence,
        continuationAnchorsDuringPressure,
        continuationAnchorsFollowedByCompaction,
        latestProviderCacheStatus: latestProviderCacheEvidence?.status ?? null,
        latestProviderCacheBreakReason: latestProviderCacheEvidence?.reason ?? null,
        latestProviderCacheUnexpectedBreak: latestProviderCacheEvidence?.unexpectedBreak ?? false,
        latestProviderCacheChangedFields: latestProviderCacheEvidence?.changedFields ?? [],
        expectedCacheBreakReductionTurns: expectedCacheBreakCorrelation.expected,
        confirmedCacheBreaksAfterReduction: expectedCacheBreakCorrelation.confirmed,
        unconfirmedExpectedCacheBreaks: expectedCacheBreakCorrelation.unconfirmed,
        compactionsWithPostCacheObservation: postCompactionCache.observed,
        postCompactionCacheWarmObservations: postCompactionCache.warm,
        postCompactionCacheResetObservations: postCompactionCache.reset,
        economicVerdicts,
      };
    })
    .filter(
      (session) =>
        session.promptObservedTurns > 0 ||
        session.reductionObservedTurns > 0 ||
        session.messageUsageTurns > 0 ||
        session.compactionEvents > 0 ||
        session.continuationAnchorEvents > 0 ||
        session.latestProviderCacheStatus !== null ||
        session.economicVerdicts.length > 0 ||
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
    totalWorkbenchPrimaryCompactionEvents: sessions.reduce(
      (sum, session) => sum + session.workbenchPrimaryCompactionEvents,
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
    totalContinuationAnchorEvents: sessions.reduce(
      (sum, session) => sum + session.continuationAnchorEvents,
      0,
    ),
    totalContinuationAnchorsWithPressureEvidence: sessions.reduce(
      (sum, session) => sum + session.continuationAnchorsWithPressureEvidence,
      0,
    ),
    totalContinuationAnchorsDuringPressure: sessions.reduce(
      (sum, session) => sum + session.continuationAnchorsDuringPressure,
      0,
    ),
    totalContinuationAnchorsFollowedByCompaction: sessions.reduce(
      (sum, session) => sum + session.continuationAnchorsFollowedByCompaction,
      0,
    ),
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
    totalExpectedCacheBreakReductionTurns: sessions.reduce(
      (sum, session) => sum + session.expectedCacheBreakReductionTurns,
      0,
    ),
    totalConfirmedCacheBreaksAfterReduction: sessions.reduce(
      (sum, session) => sum + session.confirmedCacheBreaksAfterReduction,
      0,
    ),
    totalUnconfirmedExpectedCacheBreaks: sessions.reduce(
      (sum, session) => sum + session.unconfirmedExpectedCacheBreaks,
      0,
    ),
    totalCompactionsWithPostCacheObservation: sessions.reduce(
      (sum, session) => sum + session.compactionsWithPostCacheObservation,
      0,
    ),
    totalPostCompactionCacheWarmObservations: sessions.reduce(
      (sum, session) => sum + session.postCompactionCacheWarmObservations,
      0,
    ),
    totalPostCompactionCacheResetObservations: sessions.reduce(
      (sum, session) => sum + session.postCompactionCacheResetObservations,
      0,
    ),
    economicVerdictCounts: {
      cache_regression: sessions.reduce(
        (sum, session) =>
          sum +
          session.economicVerdicts.filter((verdict) => verdict.kind === "cache_regression").length,
        0,
      ),
      unaccounted_break: sessions.reduce(
        (sum, session) =>
          sum +
          session.economicVerdicts.filter((verdict) => verdict.kind === "unaccounted_break").length,
        0,
      ),
      wasteful: sessions.reduce(
        (sum, session) =>
          sum + session.economicVerdicts.filter((verdict) => verdict.kind === "wasteful").length,
        0,
      ),
    },
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
    workspaceRoot: runtime.identity.workspaceRoot,
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
