import { describe, expect, test } from "bun:test";
import { createRuntimeConfig, createRuntimeFixture } from "../../helpers/runtime.js";

function contextRuntime() {
  return createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.infrastructure.contextBudget.thresholds.hardRatio = 0.9;
      config.infrastructure.contextBudget.thresholds.advisoryRatio = 0.75;
      config.infrastructure.contextBudget.thresholds.headroomTokens = 1_000;
      config.infrastructure.contextBudget.predictedTurnGrowthTokens = 500;
      config.infrastructure.contextBudget.compaction.minTurnsBetween = 2;
    }),
  });
}

describe("hosted runtime context ops", () => {
  test("derives status and gate state from observed usage", () => {
    const runtime = contextRuntime();
    const usage = {
      tokens: 7_500,
      contextWindow: 10_000,
      percent: 75,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.usage.observe("session-1", usage);

    expect(runtime.ops.context.usage.get("session-1")).toEqual(usage);
    expect(runtime.ops.context.usage.getStatus("session-1", undefined)).toMatchObject({
      tokensUsed: 7_500,
      autoCompactLimitTokens: 7_500,
      compactionAdvised: true,
      forcedCompaction: false,
    });
    expect(runtime.ops.context.compaction.getGateStatus("session-1")).toMatchObject({
      required: false,
      reason: "usage_threshold",
      status: {
        compactionAdvised: true,
      },
    });
  });

  test("checkAndRequest records pending reason and hard gate blocks non-critical tools", () => {
    const runtime = contextRuntime();
    const usage = {
      tokens: 9_000,
      contextWindow: 10_000,
      percent: 90,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.usage.observe("session-1", usage);
    const request = runtime.ops.context.compaction.checkAndRequest("session-1", usage);

    expect(request).toMatchObject({
      requested: true,
      required: true,
      reason: "hard_limit",
      status: {
        forcedCompaction: true,
      },
    });
    expect(runtime.ops.context.compaction.getPendingReason("session-1")).toBe("hard_limit");
    expect(
      runtime.ops.context.compaction.checkGate("session-1", "workflow_status", usage),
    ).toMatchObject({
      required: true,
      reason: "context_compaction_gate_required",
    });
    expect(
      runtime.ops.tools.access.explain({
        sessionId: "session-1",
        toolName: "workflow_status",
      }),
    ).toEqual({ allowed: false, reason: "context_compaction_gate_required" });
    expect(
      runtime.ops.tools.access.explain({
        sessionId: "session-1",
        toolName: "workbench_compact",
      }),
    ).toEqual({ allowed: true });
    expect(
      runtime.ops.tools.invocation.start({
        sessionId: "session-1",
        toolName: "workflow_status",
        usage,
        runtimeCapabilityAccess: { allowed: true, basis: "test" },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "context_compaction_gate_required",
    });
    runtime.ops.context.telemetry.gateCleared({
      sessionId: "session-1",
      payload: { reason: "session_compact_performed" },
    });
    expect(
      runtime.ops.tools.access.explain({
        sessionId: "session-1",
        toolName: "workflow_status",
      }),
    ).toEqual({ allowed: true });
  });

  test("compaction receipts replace stale high-water usage before the next gate check", () => {
    const runtime = contextRuntime();
    const usage = {
      tokens: 9_000,
      contextWindow: 10_000,
      percent: 90,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.usage.observe("session-1", usage);
    runtime.ops.context.compaction.checkAndRequest("session-1", usage);
    runtime.ops.session.compaction.commit("session-1", {
      compactId: "compact-1",
      sourceTurn: 1,
      firstKeptEntryId: "entry-1",
      toTokens: 2_500,
    });

    expect(runtime.ops.context.usage.getStatus("session-1", undefined)).toMatchObject({
      tokensUsed: 2_500,
      compactionAdvised: false,
      forcedCompaction: false,
    });
    expect(runtime.ops.context.compaction.getPendingReason("session-1")).toBeNull();
    expect(
      runtime.ops.tools.invocation.start({
        sessionId: "session-1",
        toolName: "workflow_status",
        runtimeCapabilityAccess: { allowed: true, basis: "test" },
      }),
    ).toMatchObject({
      allowed: true,
    });
  });

  test("disabled context budget records usage without arming pressure gates", () => {
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.enabled = false;
        config.infrastructure.contextBudget.thresholds.hardRatio = 0.9;
        config.infrastructure.contextBudget.thresholds.advisoryRatio = 0.75;
        config.infrastructure.contextBudget.thresholds.headroomTokens = 1_000;
      }),
    });
    const usage = {
      tokens: 9_500,
      contextWindow: 10_000,
      percent: 95,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.usage.observe("session-disabled", usage);

    expect(runtime.ops.context.usage.getStatus("session-disabled", usage)).toMatchObject({
      tokensUsed: 9_500,
      compactionAdvised: false,
      forcedCompaction: false,
      predictedOverflow: false,
    });
    expect(runtime.ops.context.compaction.checkAndRequest("session-disabled", usage)).toMatchObject(
      {
        requested: false,
        required: false,
        reason: "not_required",
        status: {
          compactionAdvised: false,
          forcedCompaction: false,
        },
      },
    );
  });

  test("auto compaction breaker is rebuilt from failed and completed evidence", () => {
    const runtime = contextRuntime();
    const usage = {
      tokens: 8_000,
      contextWindow: 10_000,
      percent: 80,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.usage.observe("session-breaker", usage);
    for (let turn = 1; turn <= 3; turn += 1) {
      runtime.ops.context.telemetry.autoFailed({
        sessionId: "session-breaker",
        turn,
        payload: { reason: "usage_threshold", error: "test_failure" },
      });
    }

    expect(
      runtime.ops.context.compaction.resolveEligibility({
        sessionId: "session-breaker",
        usage,
        hasUI: true,
        idle: true,
      }),
    ).toEqual({
      eligible: false,
      reason: "auto_compaction_breaker_open",
      decision: "skip",
    });

    runtime.ops.context.telemetry.autoCompleted({
      sessionId: "session-breaker",
      turn: 4,
      payload: { reason: "usage_threshold" },
    });

    expect(
      runtime.ops.context.compaction.resolveEligibility({
        sessionId: "session-breaker",
        usage,
        hasUI: true,
        idle: true,
      }),
    ).toEqual({
      eligible: true,
      reason: "usage_threshold",
      decision: "execute",
    });
  });

  test("auto compaction skips as ineffective when recent committed reductions stay below the shrink floor", () => {
    const runtime = contextRuntime();
    const usage = {
      tokens: 8_000,
      contextWindow: 10_000,
      percent: 80,
      maxOutputTokens: 1_000,
    };

    runtime.ops.context.lifecycle.onTurnStart("session-ineffective", 10);
    // Two committed receipts at old turns (turnsSinceCompaction >= windowTurns, so
    // the recent-compaction guard does not fire) that each reduced context ~5% —
    // below the 0.1 default shrink floor, so the auto path should defer.
    runtime.ops.session.compaction.commit("session-ineffective", {
      compactId: "c-a",
      sourceTurn: 1,
      firstKeptEntryId: "e1",
      fromTokens: 10_000,
      toTokens: 9_600,
    });
    runtime.ops.session.compaction.commit("session-ineffective", {
      compactId: "c-b",
      sourceTurn: 2,
      firstKeptEntryId: "e2",
      fromTokens: 10_000,
      toTokens: 9_500,
    });

    expect(
      runtime.ops.context.compaction.resolveEligibility({
        sessionId: "session-ineffective",
        usage,
        hasUI: true,
        idle: true,
      }),
    ).toEqual({ eligible: false, reason: "compaction_ineffective", decision: "skip" });

    // An effective recent reduction (40%) clears the guard on the next check.
    runtime.ops.session.compaction.commit("session-ineffective", {
      compactId: "c-c",
      sourceTurn: 3,
      firstKeptEntryId: "e3",
      fromTokens: 10_000,
      toTokens: 6_000,
    });

    expect(
      runtime.ops.context.compaction.resolveEligibility({
        sessionId: "session-ineffective",
        usage,
        hasUI: true,
        idle: true,
      }),
    ).toEqual({ eligible: true, reason: "usage_threshold", decision: "execute" });
  });

  test("recent compaction is rebuilt from session compaction receipts after process-local state is gone", () => {
    const runtime = contextRuntime();

    runtime.ops.context.lifecycle.onTurnStart("session-1", 12);
    runtime.ops.session.compaction.commit("session-1", {
      sourceTurn: 11,
      firstKeptEntryId: "entry-11",
    });
    runtime.ops.context.usage.observe("session-1", {
      tokens: 8_000,
      contextWindow: 10_000,
      percent: 80,
      maxOutputTokens: 1_000,
    });

    expect(runtime.ops.context.compaction.getGateStatus("session-1")).toMatchObject({
      recentCompaction: true,
      windowTurns: 2,
      lastCompactionTurn: 11,
      turnsSinceCompaction: 1,
    });
  });
});
