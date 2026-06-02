import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextEvidenceReport,
  CONTEXT_EVIDENCE_SAMPLE_SCHEMA,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
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

    expect(session?.economicVerdicts.map((entry) => entry.kind).toSorted()).toEqual([
      "cache_regression",
      "unaccounted_break",
      "wasteful",
    ]);
    expect(report.aggregate.economicVerdictCounts).toEqual({
      cache_regression: 1,
      unaccounted_break: 1,
      wasteful: 1,
    });
  });

  test("uses total input-side tokens for next-turn cache waste verdicts", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-evidence-next-turn-economics-")),
    });
    const sessionId = "next-turn-economic-verdict-session";

    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId,
      namespace: "runtime.ops",
      kind: "message_end",
      version: 1,
      payload: {
        role: "assistant",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 80,
        },
      },
    });

    const report = buildContextEvidenceReport(runtime, { sessionIds: [sessionId] });
    const session = report.sessions.find((entry) => entry.sessionId === sessionId);

    expect(session?.economicVerdicts).toEqual([
      {
        kind: "wasteful",
        reason: "cache creation tokens exceeded the economic waste threshold",
        metrics: {
          compactionCacheCreationRatio: null,
          compactionGenerationInputTokens: 0,
          nextTurnCacheCreationRatio: 1,
          nextTurnInputTokens: 80,
        },
      },
    ]);
  });
});
