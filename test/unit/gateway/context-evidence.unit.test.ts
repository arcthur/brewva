import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildContextEvidenceReport,
  persistContextEvidenceReport,
  readContextEvidenceRecords,
  recordPromptStabilityEvidence,
  recordTransientReductionEvidence,
} from "../../../packages/brewva-gateway/src/runtime-plugins/context-evidence.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("context evidence", () => {
  test("persists sidecar samples and aggregates a promotion report from live evidence plus runtime facts", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-session";

    const promptTurn1 = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-a",
      turn: 1,
      timestamp: 1_740_000_000_100,
    });
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: promptTurn1,
      pressureLevel: "high",
      usageRatio: 0.88,
      pendingCompactionReason: "usage_threshold",
      gateRequired: false,
    });

    const promptTurn2 = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-a",
      turn: 2,
      timestamp: 1_740_000_000_200,
    });
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: promptTurn2,
      pressureLevel: "high",
      usageRatio: 0.89,
      pendingCompactionReason: "usage_threshold",
      gateRequired: false,
    });

    const reduction = runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      pressureLevel: "high",
      turn: 2,
      timestamp: 1_740_000_000_210,
    });
    recordTransientReductionEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: reduction,
    });

    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 12,
      totalTokens: 55,
      costUsd: 0.001,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "message_end",
      turn: 2,
      timestamp: 1_740_000_000_250,
      payload: {
        usage: {
          input: 20,
          output: 5,
          cacheRead: 30,
          cacheWrite: 12,
          totalTokens: 55,
          costTotal: 0.001,
          cacheReadReported: true,
          cacheWriteReported: true,
        },
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_compact",
      turn: 3,
      timestamp: 1_740_000_000_300,
      payload: {
        summary: "compacted after transient reduction",
      },
    });

    const samples = readContextEvidenceRecords({
      workspaceRoot: runtime.workspaceRoot,
      sessionIds: [sessionId],
    });
    expect(samples).toHaveLength(3);
    expect(samples.map((sample) => sample.kind)).toEqual([
      "prompt_stability",
      "prompt_stability",
      "transient_reduction",
    ]);

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });
    expect(report.aggregate).toMatchObject({
      sessionsObserved: 1,
      promptObservedTurns: 2,
      stablePrefixTurns: 2,
      reductionObservedTurns: 1,
      reductionCompletedTurns: 1,
      totalEstimatedTokenSavings: 580,
      totalCacheReadTokens: 30,
      totalCacheWriteTokens: 12,
      totalCompactionEvents: 1,
      sessionsWithReductionBeforeCompaction: 1,
    });
    expect(report.promotionReadiness).toEqual({
      stablePrefixTargetMet: true,
      reductionEvidenceObserved: true,
      cacheAccountingObserved: true,
      ready: true,
      gaps: [],
    });
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        stablePrefixRate: 1,
        dynamicTailStableRate: 1,
        reductionCompletedTurns: 1,
        latestScopeKey: `${sessionId}::leaf-a`,
        cacheReadTokens: 30,
        cacheWriteTokens: 12,
        cacheReadReported: true,
        cacheWriteReported: true,
        cacheAccountingObserved: true,
        compactionEvents: 1,
        firstCompactionTurn: 3,
        completedReductionTurnsBeforeFirstCompaction: 1,
      }),
    ]);

    const artifact = persistContextEvidenceReport({
      workspaceRoot: runtime.workspaceRoot,
      report,
    });
    expect(artifact.artifactRef).toBe(".orchestrator/context-evidence/report-latest.json");
    expect(existsSync(artifact.absolutePath)).toBe(true);
    expect(readFileSync(artifact.absolutePath, "utf8")).toContain(
      '"schema": "brewva.context_evidence.report.v1"',
    );
    expect(existsSync(join(runtime.workspaceRoot, ".orchestrator/context-evidence"))).toBe(true);
  });

  test("treats the first prompt sample in a new scope as a fresh stable-prefix baseline", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-scope-reset";
    const evidenceDirectory = join(runtime.workspaceRoot, ".orchestrator/context-evidence");
    const evidencePath = join(
      evidenceDirectory,
      `sess_${Buffer.from(sessionId, "utf8").toString("base64url")}.jsonl`,
    );

    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      evidencePath,
      [
        JSON.stringify({
          schema: "brewva.context_evidence.sample.v1",
          kind: "prompt_stability",
          sessionId,
          turn: 0,
          timestamp: 1_740_000_001_000,
          scopeKey: `${sessionId}::leaf-a`,
          stablePrefixHash: "prefix-a",
          dynamicTailHash: "tail-a",
          stablePrefix: true,
          stableTail: true,
          pressureLevel: "none",
          usageRatio: 0,
          pendingCompactionReason: null,
          gateRequired: false,
        }),
        JSON.stringify({
          schema: "brewva.context_evidence.sample.v1",
          kind: "prompt_stability",
          sessionId,
          turn: 5,
          timestamp: 1_740_000_001_500,
          scopeKey: `${sessionId}::leaf-b`,
          stablePrefixHash: "prefix-b",
          dynamicTailHash: "tail-b",
          stablePrefix: false,
          stableTail: false,
          pressureLevel: "unknown",
          usageRatio: null,
          pendingCompactionReason: null,
          gateRequired: false,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });

    expect(report.aggregate.stablePrefixTurns).toBe(2);
    expect(report.aggregate.stablePrefixRate).toBe(1);
    expect(report.promotionReadiness.stablePrefixTargetMet).toBe(true);
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        promptObservedTurns: 2,
        stablePrefixTurns: 2,
        stablePrefixRate: 1,
        dynamicTailStableTurns: 1,
        dynamicTailStableRate: 0.5,
      }),
    ]);
  });

  test("does not treat normalized zero cache totals as observed accounting without explicit provider evidence", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-cache-accounting-missing";

    const prompt = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-zero-cache",
      dynamicTailHash: "tail-zero-cache",
      injectionScopeId: "leaf-zero-cache",
      turn: 1,
      timestamp: 1_740_000_002_100,
    });
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.workspaceRoot,
      sessionId,
      observed: prompt,
      pressureLevel: "none",
      usageRatio: 0.2,
      pendingCompactionReason: null,
      gateRequired: false,
    });

    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 25,
      costUsd: 0.001,
    });

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });

    expect(report.aggregate).toMatchObject({
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      sessionsWithReportedCacheRead: 0,
      sessionsWithReportedCacheWrite: 0,
      sessionsWithObservedCacheAccounting: 0,
    });
    expect(report.promotionReadiness.cacheAccountingObserved).toBe(false);
    expect(report.promotionReadiness.gaps).toContain("cache_accounting_missing");
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheReadReported: false,
        cacheWriteReported: false,
        cacheAccountingObserved: false,
      }),
    ]);
  });
});
