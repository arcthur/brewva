import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCompactionEconomicVerdicts,
  buildContextEvidenceReport,
  CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
  resolvePricingFromTimeline,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
import type {
  CompactionCachePricing,
  ProviderCacheObservationEvidenceSample,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

const HAIKU = { writeMultiplier: 1.25, readMultiplier: 0.1 };
const haikuAt = (): CompactionCachePricing => ({ status: "priced", multipliers: HAIKU });
const unpricedAt = (): CompactionCachePricing => ({ status: "unpriced_model" });
const noPricingAt = (): CompactionCachePricing => ({ status: "missing_pricing" });

function cacheObservation(
  turn: number,
  timestamp: number,
  status: ProviderCacheObservationEvidenceSample["status"] = "warm",
  expected = true,
): ProviderCacheObservationEvidenceSample {
  return {
    schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
    kind: "provider_cache_observation",
    sessionId: "session",
    turn,
    timestamp,
    source: "test",
    status,
    classification: "expected",
    expected,
    reason: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheMissTokens: 0,
    changedFields: [],
    toolSchemaEstimatedTokens: 0,
  };
}

// before missRatio = 10/100 = 0.1, after = 90/100 = 0.9 → delta 0.8 triggers cache_regression.
// dT = fromTokens - toTokens = 50000; S = toTokens = 10000 → netReuseValue = +38500.
const regressionEvent = {
  payload: {
    compactId: "compact-1",
    fromTokens: 60_000,
    toTokens: 10_000,
    cacheImpact: {
      before: { cacheReadTokens: 90, cacheWriteTokens: 10 },
      after: { cacheReadTokens: 10, cacheWriteTokens: 90 },
    },
  },
};

// Small shave (dT=2000) under a large retained suffix (S=toTokens=50000), no
// cache-ratio change → netReuseValue = -55500 (wasteful), no regression.
function lossEvent(compactId: string, timestamp?: number) {
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    payload: { compactId, fromTokens: 52_000, toTokens: 50_000 },
  };
}

describe("buildCompactionEconomicVerdicts net-reuse economics", () => {
  test("attaches per-compaction net-reuse value and compactId provenance to a per-event verdict", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [regressionEvent],
      cachePricingAt: haikuAt,
      expectedSuffixReads: 10,
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.source).toEqual({ kind: "cache_regression", compactId: "compact-1" });
    expect(regression?.netReuseValue).toBeCloseTo(38_500, 6);
    expect(regression?.netReuseInputs).toMatchObject({
      deltaTokens: 50_000,
      suffixTokens: 10_000,
      writeMultiplier: 1.25,
      readMultiplier: 0.1,
      expectedReads: 10,
      pAlive: 1,
    });
  });

  test("emits a null net-reuse value but keeps provenance when pricing is unavailable", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [regressionEvent],
      cachePricingAt: noPricingAt,
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.source).toEqual({ kind: "cache_regression", compactId: "compact-1" });
    expect(regression?.netReuseValue).toBeNull();
    expect(regression?.netReuseInputs).toBeNull();
  });
});

describe("buildCompactionEconomicVerdicts wasteful = netReuseValue < 0, per-cut (Phase 3)", () => {
  test("emits a per-cut wasteful verdict with provenance when the cut cost more than it freed", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("compact-waste")],
      cachePricingAt: haikuAt,
      expectedSuffixReads: 10,
    });
    const wasteful = verdicts.find((verdict) => verdict.kind === "wasteful");
    expect(wasteful?.source).toEqual({ kind: "wasteful", compactId: "compact-waste" });
    expect(wasteful?.netReuseValue).toBeCloseTo(-55_500, 6);
    expect(wasteful?.metrics.netReuseValue).toBeCloseTo(-55_500, 6);
  });

  test("emits one wasteful verdict per losing compaction (not folded by kind)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("compact-a"), lossEvent("compact-b")],
      cachePricingAt: haikuAt,
    });
    const wasteful = verdicts.filter((verdict) => verdict.kind === "wasteful");
    expect(
      wasteful
        .map((verdict) => verdict.source?.compactId ?? "")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["compact-a", "compact-b"]);
  });

  test("deduplicates one compaction surfacing as repeated events by compactId", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("compact-dup"), lossEvent("compact-dup")],
      cachePricingAt: haikuAt,
    });
    expect(verdicts.filter((verdict) => verdict.kind === "wasteful")).toHaveLength(1);
  });

  test("does not emit wasteful when the net-reuse value is non-negative", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [regressionEvent],
      cachePricingAt: haikuAt,
    });
    expect(verdicts.some((verdict) => verdict.kind === "wasteful")).toBe(false);
  });

  test("does not emit wasteful when economics cannot resolve (no pricing)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("compact-waste")],
      cachePricingAt: noPricingAt,
    });
    expect(verdicts.some((verdict) => verdict.kind === "wasteful")).toBe(false);
  });

  test("emits wasteful from a net-reuse loss even without cache-impact evidence", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("compact-no-impact")],
      cachePricingAt: haikuAt,
    });
    const wasteful = verdicts.find((verdict) => verdict.kind === "wasteful");
    expect(wasteful?.source).toEqual({ kind: "wasteful", compactId: "compact-no-impact" });
    expect(wasteful?.netReuseValue).toBeCloseTo(-55_500, 6);
  });
});

// Live calibration shape (session 1de74ac4): the summary GREW the context —
// fromTokens 103 → toTokens 292, dT = -189. An observed expansion is the most
// wasteful outcome and must never map to the missing-data null.
function expansionEvent(compactId: string, timestamp?: number) {
  return {
    ...(timestamp === undefined ? {} : { timestamp }),
    payload: { compactId, fromTokens: 103, toTokens: 292 },
  };
}

describe("buildCompactionEconomicVerdicts observed expansion (deltaTokens <= 0)", () => {
  test("a cut whose summary grew the context is wasteful, not verdict-less", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [expansionEvent("compact-grew")],
      cachePricingAt: haikuAt,
      expectedSuffixReads: 10,
    });
    const wasteful = verdicts.find((verdict) => verdict.kind === "wasteful");
    // -189*2.15 - 1.15*(292-189) = -524.8
    expect(wasteful?.netReuseValue).toBeCloseTo(-524.8, 6);
    expect(wasteful?.reason).toContain("did not shrink");
    expect(wasteful?.grade).toBe("estimated");
    expect(wasteful?.metrics.deltaTokens).toBe(-189);
    // Economics resolved, so the cut is not inconclusive.
    expect(verdicts.some((verdict) => verdict.kind === "inconclusive")).toBe(false);
  });

  test("an expansion grades measured when an informative observation follows", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [expansionEvent("compact-grew", 1_000)],
      cachePricingAt: haikuAt,
      providerCacheSamples: [cacheObservation(7, 2_000, "warm")],
    });
    const wasteful = verdicts.find((verdict) => verdict.kind === "wasteful");
    expect(wasteful?.grade).toBe("measured");
    expect(wasteful?.source).toMatchObject({
      kind: "wasteful",
      compactId: "compact-grew",
      observationStatus: "warm",
    });
  });
});

describe("buildCompactionEconomicVerdicts inconclusive economics (axiom 7)", () => {
  test("an unpriced model yields inconclusive naming unpriced_model, never silence", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [expansionEvent("compact-unpriced")],
      cachePricingAt: unpricedAt,
    });
    expect(verdicts).toHaveLength(1);
    const inconclusive = verdicts[0]!;
    expect(inconclusive.kind).toBe("inconclusive");
    expect(inconclusive.reason).toBe("unpriced_model");
    expect(inconclusive.grade).toBe("inconclusive");
    expect(inconclusive.netReuseValue).toBeNull();
    expect(inconclusive.netReuseInputs).toBeNull();
    // The observed cut stays legible even without pricing: the summary grew.
    expect(inconclusive.metrics).toEqual({ deltaTokens: -189, suffixTokens: 292 });
    expect(inconclusive.source).toEqual({ kind: "inconclusive", compactId: "compact-unpriced" });
  });

  test("no pricing basis at all names missing_pricing (default resolver)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [expansionEvent("compact-nobasis")],
    });
    const inconclusive = verdicts.find((verdict) => verdict.kind === "inconclusive");
    expect(inconclusive?.reason).toBe("missing_pricing");
    expect(inconclusive?.grade).toBe("inconclusive");
  });

  test("a priced cut without token counts names missing_token_counts", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [{ payload: { compactId: "compact-notokens" } }],
      cachePricingAt: haikuAt,
    });
    const inconclusive = verdicts.find((verdict) => verdict.kind === "inconclusive");
    expect(inconclusive?.reason).toBe("missing_token_counts");
    expect(inconclusive?.metrics).toEqual({ deltaTokens: null, suffixTokens: null });
  });

  test("stays inconclusive even when an informative observation follows the cut", () => {
    // The observation measures the cache outcome, not the unresolved economics —
    // it must not promote this verdict to measured nor leak into its source.
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [expansionEvent("compact-unpriced", 1_000)],
      cachePricingAt: unpricedAt,
      providerCacheSamples: [cacheObservation(7, 2_000, "warm")],
    });
    const inconclusive = verdicts.find((verdict) => verdict.kind === "inconclusive");
    expect(inconclusive?.grade).toBe("inconclusive");
    expect(inconclusive?.source).toEqual({ kind: "inconclusive", compactId: "compact-unpriced" });
  });

  test("does not emit inconclusive when economics resolve (non-negative cut)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [regressionEvent],
      cachePricingAt: haikuAt,
    });
    expect(verdicts.some((verdict) => verdict.kind === "inconclusive")).toBe(false);
  });

  test("emits inconclusive alongside cache-impact verdicts for the same unresolved cut", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [regressionEvent],
      cachePricingAt: noPricingAt,
    });
    expect(verdicts.map((verdict) => verdict.kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "cache_regression",
      "inconclusive",
    ]);
  });
});

describe("buildCompactionEconomicVerdicts per-compaction pricing", () => {
  test("prices each compaction at the model active at its own timestamp", () => {
    const OLD = { writeMultiplier: 1.25, readMultiplier: 0.1 };
    const NEW = { writeMultiplier: 5, readMultiplier: 0.5 };
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [lossEvent("c-old", 500), lossEvent("c-new", 1_500)],
      // Model switched at t=1000; older compaction must keep the old pricing.
      cachePricingAt: (timestamp) => ({
        status: "priced",
        multipliers: typeof timestamp === "number" && timestamp >= 1_000 ? NEW : OLD,
      }),
    });
    const old = verdicts.find((verdict) => verdict.source?.compactId === "c-old");
    const current = verdicts.find((verdict) => verdict.source?.compactId === "c-new");
    expect(old?.netReuseInputs?.writeMultiplier).toBe(1.25);
    expect(current?.netReuseInputs?.writeMultiplier).toBe(5);
  });
});

describe("buildCompactionEconomicVerdicts honesty grade", () => {
  const timedRegression = { ...regressionEvent, timestamp: 1_000 };

  test("grades measured and records the observation outcome (turn/status/expected)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [timedRegression],
      cachePricingAt: haikuAt,
      providerCacheSamples: [cacheObservation(7, 2_000, "break", false)],
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.grade).toBe("measured");
    expect(regression?.source).toEqual({
      kind: "cache_regression",
      compactId: "compact-1",
      observationTurn: 7,
      observationStatus: "break",
      observationExpected: false,
      observationReason: null,
    });
  });

  test("treats a `limited` observation as non-informative (not measured)", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [timedRegression],
      cachePricingAt: haikuAt,
      providerCacheSamples: [cacheObservation(7, 2_000, "limited")],
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.grade).toBe("estimated");
    expect(regression?.source).toEqual({ kind: "cache_regression", compactId: "compact-1" });
  });

  test("grades estimated when economics resolve but no later observation exists", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [timedRegression],
      cachePricingAt: haikuAt,
      providerCacheSamples: [cacheObservation(3, 500)],
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.grade).toBe("estimated");
  });

  test("grades inconclusive when economics cannot resolve", () => {
    const verdicts = buildCompactionEconomicVerdicts({
      compactionEvents: [timedRegression],
      cachePricingAt: noPricingAt,
    });
    const regression = verdicts.find((verdict) => verdict.kind === "cache_regression");
    expect(regression?.grade).toBe("inconclusive");
  });
});

describe("resolvePricingFromTimeline", () => {
  const OLD = { writeMultiplier: 1.25, readMultiplier: 0.1 };
  const NEW = { writeMultiplier: 5, readMultiplier: 0.5 };
  const timeline = [
    { atTimestamp: 100, multipliers: OLD },
    { atTimestamp: 1_000, multipliers: NEW },
  ];

  test("resolves missing_pricing for an empty timeline", () => {
    expect(resolvePricingFromTimeline([], 500)).toEqual({ status: "missing_pricing" });
  });

  test("resolves missing_pricing before the first model selection", () => {
    expect(resolvePricingFromTimeline(timeline, 50)).toEqual({ status: "missing_pricing" });
  });

  test("picks the latest basis at or before the timestamp", () => {
    expect(resolvePricingFromTimeline(timeline, 500)).toEqual({
      status: "priced",
      multipliers: OLD,
    });
    expect(resolvePricingFromTimeline(timeline, 1_000)).toEqual({
      status: "priced",
      multipliers: NEW,
    });
    expect(resolvePricingFromTimeline(timeline, 2_000)).toEqual({
      status: "priced",
      multipliers: NEW,
    });
  });

  test("falls back to the most recent basis when the timestamp is unknown", () => {
    expect(resolvePricingFromTimeline(timeline, undefined)).toEqual({
      status: "priced",
      multipliers: NEW,
    });
  });

  test("an unpriced selection shadows earlier priced bases instead of leaking stale pricing", () => {
    const shadowed = [
      { atTimestamp: 100, multipliers: OLD },
      { atTimestamp: 1_000, multipliers: null },
    ];
    expect(resolvePricingFromTimeline(shadowed, 2_000)).toEqual({ status: "unpriced_model" });
    expect(resolvePricingFromTimeline(shadowed, 500)).toEqual({
      status: "priced",
      multipliers: OLD,
    });
    expect(resolvePricingFromTimeline(shadowed, undefined)).toEqual({ status: "unpriced_model" });
  });
});

describe("buildContextEvidenceReport net-reuse end-to-end", () => {
  function recordHaiku(
    runtime: ReturnType<typeof createRuntimeInstanceFixture>,
    sessionId: string,
  ) {
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "model_select",
      version: 1,
      payload: { provider: "anthropic", model: "claude-haiku-4-5" },
    });
  }

  function commitRegression(
    runtime: ReturnType<typeof createRuntimeInstanceFixture>,
    sessionId: string,
    compactId: string,
  ) {
    runtime.ops.session.compaction.commit(sessionId, {
      compactId,
      sanitizedSummary: "Compacted.",
      fromTokens: 60_000,
      toTokens: 10_000,
      cacheImpact: {
        before: { cacheReadTokens: 90, cacheWriteTokens: 10 },
        after: { cacheReadTokens: 10, cacheWriteTokens: 90 },
      },
    });
  }

  test("resolves the session model pricing and attaches a net-reuse value to the verdict", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-net-reuse-e2e-")),
    });
    const sessionId = "net-reuse-e2e-session";
    recordHaiku(runtime, sessionId);
    commitRegression(runtime, sessionId, "compact-e2e");

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    const regression = session?.economicVerdicts.find(
      (verdict) => verdict.kind === "cache_regression",
    );
    expect(regression?.source).toEqual({ kind: "cache_regression", compactId: "compact-e2e" });
    expect(regression?.netReuseValue).toBeCloseTo(38_500, 6);
    expect(regression?.netReuseInputs?.suffixTokens).toBe(10_000);
    // Economics resolved, but no provider cache observation followed → estimated.
    expect(regression?.grade).toBe("estimated");
  });

  test("grades a verdict measured when a later provider cache observation is recorded", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-net-reuse-measured-")),
    });
    const sessionId = "net-reuse-measured-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify({
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "provider_cache_observation",
        sessionId,
        turn: 9,
        timestamp: 9_999_999_999_999,
        source: "test",
        status: "break",
        classification: "unexpected",
        expected: false,
        reason: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        changedFields: [],
      })}\n`,
      "utf8",
    );
    recordHaiku(runtime, sessionId);
    commitRegression(runtime, sessionId, "compact-measured");

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    const regression = session?.economicVerdicts.find(
      (verdict) => verdict.kind === "cache_regression",
    );
    expect(regression?.grade).toBe("measured");
    expect(regression?.source).toMatchObject({
      kind: "cache_regression",
      compactId: "compact-measured",
      observationTurn: 9,
      observationStatus: "break",
      observationExpected: false,
    });
  });

  test("emits a null net-reuse value when no session model is recorded", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-net-reuse-nopricing-")),
    });
    const sessionId = "net-reuse-nopricing-session";
    commitRegression(runtime, sessionId, "compact-nopricing");

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    const regression = session?.economicVerdicts.find(
      (verdict) => verdict.kind === "cache_regression",
    );
    expect(regression?.source).toEqual({
      kind: "cache_regression",
      compactId: "compact-nopricing",
    });
    expect(regression?.netReuseValue).toBeNull();
    expect(regression?.grade).toBe("inconclusive");
    // The unresolved economics are named, not silent.
    const inconclusive = session?.economicVerdicts.find(
      (verdict) => verdict.kind === "inconclusive",
    );
    expect(inconclusive?.reason).toBe("missing_pricing");
  });

  test("a model unknown to the catalog yields inconclusive(unpriced_model), not silence", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-net-reuse-unpriced-")),
    });
    const sessionId = "net-reuse-unpriced-session";
    // Self-hosted relay models carry no usable cache pricing in the catalog.
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "model_select",
      version: 1,
      payload: { provider: "super-relay", model: "glm5.2" },
    });
    // Live calibration shape: the summary grew (103 → 292) and burned summarizer
    // tokens; before this fix the session reported economicVerdicts: [].
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-relay",
      sanitizedSummary: "Compacted.",
      fromTokens: 103,
      toTokens: 292,
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    expect(session?.economicVerdicts).toHaveLength(1);
    const inconclusive = session?.economicVerdicts[0];
    expect(inconclusive?.kind).toBe("inconclusive");
    expect(inconclusive?.reason).toBe("unpriced_model");
    expect(inconclusive?.grade).toBe("inconclusive");
    expect(inconclusive?.metrics).toEqual({ deltaTokens: -189, suffixTokens: 292 });
  });

  test("switching to an unpriced model shadows the earlier priced basis", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-net-reuse-shadow-")),
    });
    const sessionId = "net-reuse-shadow-session";
    recordHaiku(runtime, sessionId);
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "model_select",
      version: 1,
      payload: { provider: "super-relay", model: "glm5.2" },
    });
    // A losing cut under the relay must NOT be priced with the stale haiku basis.
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-shadowed",
      sanitizedSummary: "Compacted.",
      fromTokens: 52_000,
      toTokens: 50_000,
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    expect(session?.economicVerdicts.some((verdict) => verdict.kind === "wasteful")).toBe(false);
    const inconclusive = session?.economicVerdicts.find(
      (verdict) => verdict.kind === "inconclusive",
    );
    expect(inconclusive?.reason).toBe("unpriced_model");
  });
});
