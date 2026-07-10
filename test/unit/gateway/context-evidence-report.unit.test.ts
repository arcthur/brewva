import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextEvidenceReport,
  CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
import { observeHostedProviderCache } from "../../../packages/brewva-gateway/src/hosted/internal/context/materialization.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

describe("context evidence report continuation anchor metrics", () => {
  test("counts anchors under pressure and anchors followed by replay-visible compaction", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-anchor-")),
    });
    const sessionId = "anchor-pressure-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify({
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "prompt_stability",
        sessionId,
        turn: 1,
        timestamp: Date.now() - 10_000,
        scopeKey: "scope:1",
        stablePrefixHash: "prefix",
        dynamicTailHash: "tail",
        stablePrefix: true,
        stableTail: true,
        compactionAdvised: true,
        forcedCompaction: false,
        usageRatio: 0.9,
        pendingCompactionReason: "usage_threshold",
        gateRequired: false,
      })}\n`,
      "utf8",
    );

    const anchor = runtime.ops.tape.handoff.record(sessionId, {
      name: "Pressure anchor",
      summary: "Pressure is high; continue after compaction if needed.",
      nextSteps: "Compact before broad scans.",
    });
    expect(anchor.ok).toBe(true);
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-after-anchor",
      sanitizedSummary: "Compacted after pressure anchor.",
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session).toMatchObject({
      continuationAnchorEvents: 1,
      continuationAnchorsWithPressureEvidence: 1,
      continuationAnchorsDuringPressure: 1,
      continuationAnchorsFollowedByCompaction: 1,
    });
    expect(report.aggregate).toMatchObject({
      totalContinuationAnchorEvents: 1,
      totalContinuationAnchorsWithPressureEvidence: 1,
      totalContinuationAnchorsDuringPressure: 1,
      totalContinuationAnchorsFollowedByCompaction: 1,
    });
  });

  test("does not count future-turn pressure evidence as anchor pressure", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-anchor-turn-")),
    });
    const sessionId = "anchor-pressure-turn-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    const anchorTimestamp = Date.now();
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify({
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "prompt_stability",
        sessionId,
        turn: 3,
        timestamp: anchorTimestamp - 1_000,
        scopeKey: "scope:future",
        stablePrefixHash: "future-prefix",
        dynamicTailHash: "future-tail",
        stablePrefix: true,
        stableTail: true,
        compactionAdvised: true,
        forcedCompaction: false,
        usageRatio: 0.9,
        pendingCompactionReason: "usage_threshold",
        gateRequired: false,
      })}\n`,
      "utf8",
    );

    runtime.runtime.kernel.recordAdvisoryEvent({
      id: "anchor-turn-2",
      sessionId,
      turnId: "2",
      timestamp: anchorTimestamp,
      namespace: "runtime.ops",
      kind: "tape.handoff",
      version: 1,
      payload: {
        id: "anchor-turn-2",
        summary: "Continue before later pressure evidence.",
      },
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session).toMatchObject({
      continuationAnchorEvents: 1,
      continuationAnchorsWithPressureEvidence: 0,
      continuationAnchorsDuringPressure: 0,
      continuationAnchorsFollowedByCompaction: 0,
    });
  });

  test("emits compaction economic verdicts from receipt fixture data", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-economics-")),
    });
    const sessionId = "economic-verdict-session";

    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-economic",
      sanitizedSummary: "summary",
      cacheImpact: {
        before: {
          cacheReadTokens: 900,
          cacheWriteTokens: 100,
        },
        after: {
          cacheReadTokens: 500,
          cacheWriteTokens: 500,
        },
        explicitEpochChanges: 2,
        prefixBytesChanged: null,
      },
      summaryGeneration: {
        strategy: "llm_primary_compaction",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 80,
          totalTokens: 200,
        },
      },
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    // No session model is recorded, so net-reuse economics stay null: the
    // per-cut `wasteful` verdict (Phase 3) cannot fire, and the unresolved
    // economics surface as a named `inconclusive` verdict beside the
    // cache-impact verdicts (axiom 7: absence of pricing is never silence).
    expect(
      session?.economicVerdicts.map((entry) => entry.kind).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["cache_regression", "inconclusive", "unaccounted_break"]);
    expect(report.aggregate.economicVerdictCounts).toEqual({
      cache_regression: 1,
      inconclusive: 1,
      unaccounted_break: 1,
      wasteful: 0,
    });
  });

  test("emits a per-cut wasteful verdict from a net-reuse loss (Phase 3)", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-net-reuse-loss-")),
    });
    const sessionId = "net-reuse-loss-session";

    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "model_select",
      version: 1,
      payload: { provider: "anthropic", model: "claude-haiku-4-5" },
    });
    // Small shave (dT=2000) under a large retained suffix (S=toTokens=50000):
    // netReuseValue = -55500 < 0 → wasteful. cacheImpact unchanged → no regression.
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-loss",
      sanitizedSummary: "summary",
      fromTokens: 52_000,
      toTokens: 50_000,
      cacheImpact: {
        before: { cacheReadTokens: 90, cacheWriteTokens: 10 },
        after: { cacheReadTokens: 90, cacheWriteTokens: 10 },
      },
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);
    const wasteful = session?.economicVerdicts.find((entry) => entry.kind === "wasteful");

    expect(wasteful?.source).toEqual({ kind: "wasteful", compactId: "compact-loss" });
    expect(wasteful?.netReuseValue).toBeCloseTo(-55_500, 6);
    expect(report.aggregate.economicVerdictCounts.wasteful).toBe(1);
  });
});

describe("context evidence report cache correlation metrics", () => {
  test("correlates expected cache breaks and post-compaction observations", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-cache-correlation-")),
    });
    const sessionId = "cache-correlation-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const base = Date.now() - 60_000;
    const samples = [
      {
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "transient_reduction",
        sessionId,
        turn: 1,
        timestamp: base,
        status: "completed",
        reason: null,
        eligibleToolResults: 3,
        clearedToolResults: 2,
        clearedChars: 4_000,
        estimatedTokenSavings: 1_000,
        compactionAdvised: true,
        forcedCompaction: false,
        expectedCacheBreak: true,
      },
      {
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "provider_cache_observation",
        sessionId,
        turn: 2,
        timestamp: base + 1_000,
        source: "provider_response",
        status: "break",
        classification: "prefixResetting",
        expected: true,
        reason: "transient_outbound_reduction",
        cacheReadTokens: 0,
        cacheWriteTokens: 5_000,
        cacheMissTokens: 5_000,
        changedFields: [],
      },
    ];
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
      "utf8",
    );

    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-cache-correlation",
      sanitizedSummary: "Compacted for cache correlation test.",
    });
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "compact-cache-correlation",
      sanitizedSummary: "Duplicate receipt surface for the same compaction.",
    });
    const postCompactionSample = {
      schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
      kind: "provider_cache_observation",
      sessionId,
      turn: 3,
      timestamp: Date.now() + 5_000,
      source: "provider_response",
      status: "warm",
      classification: "prefixPreserving",
      expected: true,
      reason: null,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 100,
      cacheMissTokens: 0,
      changedFields: [],
    };
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${[...samples, postCompactionSample].map((sample) => JSON.stringify(sample)).join("\n")}\n`,
      "utf8",
    );

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session).toMatchObject({
      expectedCacheBreakReductionTurns: 1,
      confirmedCacheBreaksAfterReduction: 1,
      unconfirmedExpectedCacheBreaks: 0,
      compactionsWithPostCacheObservation: 1,
      postCompactionCacheWarmObservations: 1,
      postCompactionCacheResetObservations: 0,
    });
    expect(report.aggregate).toMatchObject({
      totalExpectedCacheBreakReductionTurns: 1,
      totalConfirmedCacheBreaksAfterReduction: 1,
      totalUnconfirmedExpectedCacheBreaks: 0,
      totalCompactionsWithPostCacheObservation: 1,
      totalPostCompactionCacheWarmObservations: 1,
      totalPostCompactionCacheResetObservations: 0,
    });
  });
});

describe("context evidence report tool-schema cost", () => {
  test("surfaces the latest provider-visible tool-schema token estimate", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-tool-schema-")),
    });
    const sessionId = "tool-schema-estimate-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const base = Date.now() - 30_000;
    const samples = [
      {
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "provider_cache_observation",
        sessionId,
        turn: 1,
        timestamp: base,
        source: "provider_response",
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
        reason: null,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 100,
        cacheMissTokens: 0,
        changedFields: [],
        toolSchemaEstimatedTokens: 400,
      },
      {
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "provider_cache_observation",
        sessionId,
        turn: 2,
        timestamp: base + 1_000,
        source: "provider_response",
        status: "break",
        classification: "prefixPreserving",
        expected: false,
        reason: "tool_schema_set_changed",
        cacheReadTokens: 1_000,
        cacheWriteTokens: 7_000,
        cacheMissTokens: 7_000,
        changedFields: ["toolSchemaSnapshotHash", "tool:browser_click"],
        toolSchemaEstimatedTokens: 1_200,
      },
    ];
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`,
      "utf8",
    );

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session).toMatchObject({
      latestToolSchemaEstimatedTokens: 1_200,
      latestProviderCacheBreakReason: "tool_schema_set_changed",
    });
    expect(report.aggregate).toMatchObject({
      sessionsWithToolSchemaEstimate: 1,
      totalLatestToolSchemaEstimatedTokens: 1_200,
      providerCacheBreakReasonCounts: { tool_schema_set_changed: 1 },
    });
  });

  test("threads the assembly-time estimate through observeHostedProviderCache into the report", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-tool-schema-thread-")),
    });
    const sessionId = "tool-schema-threading-session";

    observeHostedProviderCache({
      runtime,
      sessionId,
      toolSchemaEstimatedTokens: 1_234,
      observation: {
        source: "provider_response",
        turn: 1,
        timestamp: Date.now(),
        fingerprint: {
          bucketKey: "bucket",
          stablePrefixHash: "prefix",
          dynamicTailHash: "tail",
        },
        breakObservation: {
          status: "warm",
          classification: "prefixPreserving",
          expected: false,
          reason: null,
          cacheReadTokens: 8_000,
          cacheWriteTokens: 0,
          cacheMissTokens: 0,
          changedFields: [],
        },
      },
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session?.latestToolSchemaEstimatedTokens).toBe(1_234);
    expect(report.aggregate.totalLatestToolSchemaEstimatedTokens).toBe(1_234);
  });

  test("defaults the tool-schema estimate to zero for pre-feature samples", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-tool-schema-legacy-")),
    });
    const sessionId = "tool-schema-legacy-session";
    const evidenceDir = join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      join(evidenceDir, `session-${encodeURIComponent(sessionId)}.jsonl`),
      `${JSON.stringify({
        schema: CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
        kind: "provider_cache_observation",
        sessionId,
        turn: 1,
        timestamp: Date.now() - 5_000,
        source: "provider_response",
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
        reason: null,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        changedFields: [],
      })}\n`,
      "utf8",
    );

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session?.latestToolSchemaEstimatedTokens).toBe(0);
  });
});
