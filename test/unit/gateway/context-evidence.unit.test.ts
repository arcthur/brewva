import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  createOperatorRuntimePort,
  createHostedRuntimePort,
} from "@brewva/brewva-runtime";
import {
  buildContextEvidenceReport,
  persistContextEvidenceReport,
  readContextEvidenceRecords,
  recordProviderCacheObservationEvidence,
  recordPromptStabilityEvidence,
  recordTransientReductionEvidence,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/evidence/context-evidence.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

async function waitForEvidenceFile(input: {
  workspaceRoot: string;
  sessionId: string;
  expectedKind: string;
}): Promise<void> {
  const evidencePath = join(
    input.workspaceRoot,
    ".orchestrator/context-evidence",
    `sess_${Buffer.from(input.sessionId, "utf8").toString("base64url")}.jsonl`,
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      existsSync(evidencePath) &&
      readFileSync(evidencePath, "utf8").includes(input.expectedKind)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${input.expectedKind} evidence in ${evidencePath}.`);
}

describe("context evidence", () => {
  test("persists sidecar samples and aggregates a promotion report from live evidence plus runtime facts", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-session";

    const promptTurn1 = createOperatorRuntimePort(runtime).operator.context.prompt.observeStability(
      sessionId,
      {
        stablePrefixHash: "prefix-1",
        dynamicTailHash: "tail-1",
        contextScopeId: "leaf-a",
        turn: 1,
        timestamp: 1_740_000_000_100,
      },
    );
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      observed: promptTurn1,
      compactionAdvised: true,
      forcedCompaction: false,
      usageRatio: 0.88,
      pendingCompactionReason: "usage_threshold",
      gateRequired: false,
    });

    const promptTurn2 = createOperatorRuntimePort(runtime).operator.context.prompt.observeStability(
      sessionId,
      {
        stablePrefixHash: "prefix-1",
        dynamicTailHash: "tail-1",
        contextScopeId: "leaf-a",
        turn: 2,
        timestamp: 1_740_000_000_200,
      },
    );
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      observed: promptTurn2,
      compactionAdvised: true,
      forcedCompaction: false,
      usageRatio: 0.89,
      pendingCompactionReason: "usage_threshold",
      gateRequired: false,
    });

    const reduction = createOperatorRuntimePort(
      runtime,
    ).operator.context.prompt.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      compactionAdvised: true,
      forcedCompaction: false,
      turn: 2,
      timestamp: 1_740_000_000_210,
    });
    recordTransientReductionEvidence({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      observed: reduction,
    });

    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test/model",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 12,
      totalTokens: 55,
      costUsd: 0.001,
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
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
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_compact",
      turn: 3,
      timestamp: 1_740_000_000_300,
      payload: {
        summary: "compacted after transient reduction",
      },
    });

    const samples = readContextEvidenceRecords({
      workspaceRoot: runtime.identity.workspaceRoot,
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
      messageUsageTurns: 1,
      reductionObservedTurns: 1,
      reductionCompletedTurns: 1,
      totalEstimatedTokenSavings: 580,
      totalUncachedInputTokens: 20,
      totalCachedInputTokens: 30,
      totalProviderInputTokens: 50,
      promptCacheHitRate: 0.6,
      uncachedInputTokensPerUsefulTurn: 20,
      totalCacheReadTokens: 30,
      totalCacheWriteTokens: 12,
      totalCompactionEvents: 1,
      sessionsWithReductionBeforeCompaction: 1,
    });
    expect(report.promotionReadiness).toEqual({
      stablePrefixTargetMet: true,
      reductionEvidenceObserved: true,
      cacheAccountingObserved: true,
      promptCacheHitTargetMet: true,
      promptCacheStopLossPassed: true,
      inputCostBaselineObserved: false,
      inputCostStopLossPassed: true,
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
        messageUsageTurns: 1,
        longSessionEligible: false,
        uncachedInputTokens: 20,
        cachedInputTokens: 30,
        providerInputTokens: 50,
        promptCacheHitRate: 0.6,
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
      workspaceRoot: runtime.identity.workspaceRoot,
      report,
    });
    expect(artifact.artifactRef).toBe(".orchestrator/context-evidence/report-latest.json");
    expect(existsSync(artifact.absolutePath)).toBe(true);
    expect(readFileSync(artifact.absolutePath, "utf8")).toContain(
      '"schema": "brewva.context_evidence.report.v1"',
    );
    expect(existsSync(join(runtime.identity.workspaceRoot, ".orchestrator/context-evidence"))).toBe(
      true,
    );
  });

  test("treats the first prompt sample in a new scope as a fresh stable-prefix baseline", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-scope-reset";
    const evidenceDirectory = join(
      runtime.identity.workspaceRoot,
      ".orchestrator/context-evidence",
    );
    const evidencePath = join(
      evidenceDirectory,
      `sess_${Buffer.from(sessionId, "utf8").toString("base64url")}.jsonl`,
    );

    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(
      evidencePath,
      [
        JSON.stringify({
          schema: "brewva.context_evidence.sample.v2",
          kind: "prompt_stability",
          sessionId,
          turn: 0,
          timestamp: 1_740_000_001_000,
          scopeKey: `${sessionId}::leaf-a`,
          stablePrefixHash: "prefix-a",
          dynamicTailHash: "tail-a",
          stablePrefix: true,
          stableTail: true,
          compactionAdvised: false,
          forcedCompaction: false,
          usageRatio: 0,
          pendingCompactionReason: null,
          gateRequired: false,
        }),
        JSON.stringify({
          schema: "brewva.context_evidence.sample.v2",
          kind: "prompt_stability",
          sessionId,
          turn: 5,
          timestamp: 1_740_000_001_500,
          scopeKey: `${sessionId}::leaf-b`,
          stablePrefixHash: "prefix-b",
          dynamicTailHash: "tail-b",
          stablePrefix: false,
          stableTail: false,
          compactionAdvised: false,
          forcedCompaction: false,
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

    const prompt = createOperatorRuntimePort(runtime).operator.context.prompt.observeStability(
      sessionId,
      {
        stablePrefixHash: "prefix-zero-cache",
        dynamicTailHash: "tail-zero-cache",
        contextScopeId: "leaf-zero-cache",
        turn: 1,
        timestamp: 1_740_000_002_100,
      },
    );
    recordPromptStabilityEvidence({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      observed: prompt,
      compactionAdvised: false,
      forcedCompaction: false,
      usageRatio: 0.2,
      pendingCompactionReason: null,
      gateRequired: false,
    });

    runtime.authority.cost.usage.recordAssistant({
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
        promptCacheHitRate: null,
        cacheReadReported: false,
        cacheWriteReported: false,
        cacheAccountingObserved: false,
      }),
    ]);
  });

  test("reports Phase B cache and input-cost stop-loss failures for long sessions", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-phase-b-stop-loss";

    for (let turn = 1; turn <= 10; turn += 1) {
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "message_end",
        turn,
        timestamp: 1_740_000_010_000 + turn,
        payload: {
          role: "assistant",
          stopReason: "end_turn",
          usage: {
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 110,
            costTotal: 0.01,
            cacheReadReported: true,
            cacheWriteReported: true,
          },
        },
      });
    }

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
      baselineUncachedInputTokensPerUsefulTurn: 50,
    });

    expect(report.aggregate).toMatchObject({
      sessionsObserved: 1,
      messageUsageTurns: 10,
      longSessionEligibleSessions: 1,
      longSessionMessageUsageTurns: 10,
      totalUncachedInputTokens: 1000,
      totalCachedInputTokens: 0,
      totalProviderInputTokens: 1000,
      promptCacheHitRate: 0,
      longSessionPromptCacheHitRate: 0,
      uncachedInputTokensPerUsefulTurn: 100,
      inputCostRegressionRatio: 1,
    });
    expect(report.promotionReadiness).toMatchObject({
      promptCacheHitTargetMet: false,
      promptCacheStopLossPassed: false,
      inputCostBaselineObserved: true,
      inputCostStopLossPassed: false,
      ready: false,
    });
    expect(report.promotionReadiness.gaps).toEqual(
      expect.arrayContaining([
        "prompt_cache_hit_stop_loss_failed",
        "input_cost_regression_stop_loss_failed",
      ]),
    );
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        longSessionEligible: true,
        promptCacheHitRate: 0,
        uncachedInputTokensPerUsefulTurn: 100,
      }),
    ]);
  });

  test("aggregates latest provider cache break reasons and changed fields from persisted samples", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-cache-break-reasons";

    const observed = createOperatorRuntimePort(runtime).operator.context.providerCache.observe(
      sessionId,
      {
        source:
          "provider=openai|api=openai-responses|model=gpt-5.4|session=context-evidence-cache-break-reasons",
        fingerprint: {
          bucketKey:
            "provider=openai|api=openai-responses|model=gpt-5.4|session=context-evidence-cache-break-reasons",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4",
          transport: "sse",
          sessionId,
          cachePolicyHash: "policy",
          toolSchemaSnapshotHash: "tools",
          toolSchemaOverlayHash: "overlay",
          perToolHashes: {},
          stablePrefixHash: "stable",
          dynamicTailHash: "tail",
          requestHash: "request",
          channelContextHash: "channel",
          renderedCacheHash: "render",
          cacheCapabilityHash: "capability",
          stickyLatchHash: "latch",
          reasoningHash: "reasoning",
          thinkingBudgetHash: "budget",
          cacheRelevantHeadersHash: "headers",
          extraBodyHash: "extra",
          visibleHistoryReductionHash: "visible",
          workbenchContextHash: "workbench",
          providerFallbackHash: "fallback",
        },
        render: {
          status: "rendered",
          reason: "rendered_openai_prompt_cache",
          renderedRetention: "short",
          bucketKey:
            "openai-responses|session=context-evidence-cache-break-reasons|retention=short|writeMode=readWrite",
        },
        breakObservation: {
          status: "break",
          classification: "prefixPreserving",
          expected: false,
          reason: "cache_read_drop_exceeded_threshold",
          previousCacheReadTokens: 12_000,
          cacheReadTokens: 2_000,
          cacheWriteTokens: 500,
          cacheMissTokens: 10_000,
          thresholdTokens: 2_000,
          relativeDropThreshold: 0.05,
          changedFields: ["dynamicTailHash", "tool:exec"],
        },
      },
    );
    recordProviderCacheObservationEvidence({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      observed,
    });
    await waitForEvidenceFile({
      workspaceRoot: runtime.identity.workspaceRoot,
      sessionId,
      expectedKind: "provider_cache_observation",
    });

    const offlineRuntime = new BrewvaRuntime({
      cwd: runtime.identity.workspaceRoot,
    });
    const report = buildContextEvidenceReport(offlineRuntime, {
      sessionIds: [sessionId],
    });

    expect(report.aggregate).toMatchObject({
      providerCacheBreakObservedSessions: 1,
      providerCacheUnexpectedBreakSessions: 1,
      providerCacheTtlExpiryBreakSessions: 0,
      providerCacheBreakReasonCounts: {
        cache_read_drop_exceeded_threshold: 1,
      },
      providerCacheChangedFieldCounts: {
        dynamicTailHash: 1,
        "tool:exec": 1,
      },
    });
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        latestProviderCacheStatus: "break",
        latestProviderCacheBreakReason: "cache_read_drop_exceeded_threshold",
        latestProviderCacheUnexpectedBreak: true,
        latestProviderCacheChangedFields: ["dynamicTailHash", "tool:exec"],
      }),
    ]);
  });

  test("aggregates compaction generation cost and cache metrics from compact receipts", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "context-evidence-compaction-generation";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_compact",
      turn: 3,
      timestamp: 1_740_000_003_000,
      payload: {
        compactId: "compact-llm",
        sanitizedSummary: "[CompactSummary]\nGenerated",
        summaryDigest: "digest-placeholder",
        sourceTurn: 3,
        leafEntryId: null,
        referenceContextDigest: null,
        fromTokens: 90_000,
        toTokens: 20_000,
        origin: "auto_compaction",
        summaryGeneration: {
          strategy: "llm_primary_compaction",
          model: {
            provider: "openai",
            id: "gpt-5.4",
            api: "openai-responses",
          },
          usage: {
            input: 1200,
            output: 340,
            cacheRead: 800,
            cacheWrite: 64,
            totalTokens: 1604,
            cost: {
              total: 0.245,
            },
          },
        },
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_compact",
      turn: 5,
      timestamp: 1_740_000_003_500,
      payload: {
        compactId: "compact-fallback",
        sanitizedSummary: "[CompactSummary]\nFallback",
        summaryDigest: "digest-placeholder-2",
        sourceTurn: 5,
        leafEntryId: null,
        referenceContextDigest: null,
        fromTokens: 100_000,
        toTokens: 25_000,
        origin: "auto_compaction",
        summaryGeneration: {
          strategy: "deterministic_emergency_compaction",
          fallbackReason: "compaction_summary_model_unavailable",
        },
      },
    });

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });

    expect(report.aggregate).toMatchObject({
      totalCompactionEvents: 2,
      totalCompactionGenerationEvents: 2,
      totalLlmPrimaryCompactionEvents: 1,
      totalDeterministicEmergencyCompactionEvents: 1,
      totalCompactionGenerationInputTokens: 1200,
      totalCompactionGenerationOutputTokens: 340,
      totalCompactionGenerationCacheReadTokens: 800,
      totalCompactionGenerationCacheWriteTokens: 64,
      totalCompactionGenerationTokens: 1604,
      totalCompactionGenerationCostUsd: 0.245,
      sessionsWithCompactionGenerationCacheAccounting: 1,
    });
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        compactionEvents: 2,
        compactionGenerationEvents: 2,
        llmPrimaryCompactionEvents: 1,
        deterministicEmergencyCompactionEvents: 1,
        compactionGenerationInputTokens: 1200,
        compactionGenerationOutputTokens: 340,
        compactionGenerationCacheReadTokens: 800,
        compactionGenerationCacheWriteTokens: 64,
        compactionGenerationTokens: 1604,
        compactionGenerationCostUsd: 0.245,
        compactionGenerationCacheAccountingObserved: true,
      }),
    ]);
  });
});
