import { afterEach, describe, expect, test } from "bun:test";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { setStaticContextPressureThresholds } from "../../fixtures/config.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
});

describe("runtime facade coverage", () => {
  test("session.pollStall records and deduplicates watchdog detection through the public session API", () => {
    let now = 1_740_000_000_000;
    Date.now = () => now;

    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-facade-poll-stall") });
    const sessionId = "runtime-facade-poll-stall-1";

    now = 1_740_000_000_100;
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Detect stalled execution through the public runtime facade",
    });

    runtime.session.pollStall(sessionId, {
      now: now + 1_001,
      thresholdsMs: {
        investigate: 1_000,
      },
    });

    const state = runtime.task.getState(sessionId);
    expect(state.blockers.some((entry) => entry.id === "watchdog:task-stuck:no-progress")).toBe(
      true,
    );

    const detected = runtime.events.query(sessionId, {
      type: "task_stuck_detected",
    });
    expect(detected).toHaveLength(1);
    expect(detected[0]?.payload).toMatchObject({
      schema: "brewva.task-watchdog.v1",
      phase: "investigate",
      blockerWritten: true,
      blockerId: "watchdog:task-stuck:no-progress",
    });

    runtime.session.pollStall(sessionId, {
      now: now + 1_500,
      thresholdsMs: {
        investigate: 1_000,
      },
    });

    expect(runtime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(1);
  });

  test("session.onClearState listeners can unsubscribe and listener failures do not block teardown", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-facade-clear-state") });
    const sessionId = "runtime-facade-clear-state-1";
    const observed: string[] = [];

    const unsubscribeObserved = runtime.session.onClearState((id) => {
      observed.push(id);
    });
    runtime.session.onClearState(() => {
      throw new Error("listener exploded");
    });

    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-1",
      status: "ok",
      summary: "first worker result",
    });

    runtime.session.clearState(sessionId);

    expect(observed).toEqual([sessionId]);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);

    unsubscribeObserved();
    unsubscribeObserved();

    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-2",
      status: "ok",
      summary: "second worker result",
    });

    runtime.session.clearState(sessionId);

    expect(observed).toEqual([sessionId]);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);
  });

  test("events.toStructured mirrors structured queries through the public events facade", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-structured-events"),
      config,
    });
    const sessionId = "runtime-facade-structured-events-1";

    const recorded = runtime.events.record({
      sessionId,
      type: "governance_cost_anomaly_detected",
      turn: 3,
      timestamp: 1_740_000_123_456,
      payload: {
        reason: "looping_token_burn",
      },
    });

    if (!recorded) {
      throw new Error("expected governance event to be recorded at debug level");
    }

    const structured = runtime.events.toStructured(recorded);
    const listed = runtime.events.queryStructured(sessionId, {
      type: "governance_cost_anomaly_detected",
    });
    const listedStructured = listed[0];

    if (!listedStructured) {
      throw new Error("expected structured governance event to be queryable");
    }

    expect(structured).toEqual(listedStructured);
    expect(structured).toMatchObject({
      schema: "brewva.event.v1",
      sessionId,
      type: "governance_cost_anomaly_detected",
      category: "governance",
      turn: 3,
      payload: {
        reason: "looping_token_burn",
      },
    });
  });

  test("context facade normalizes usage ratios, reads stored pressure, and exposes compaction window turns", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    setStaticContextPressureThresholds(config, {
      hardLimitPercent: 0.8,
      compactionThresholdPercent: 0.7,
    });
    config.infrastructure.contextBudget.compaction.minTurnsBetween = 5;
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-context"),
      config,
    });
    const sessionId = "runtime-facade-context-1";

    expect(runtime.context.getUsageRatio(undefined)).toBeNull();
    expect(
      runtime.context.getUsageRatio({
        tokens: 950,
        contextWindow: 1_000,
        percent: 95,
      }),
    ).toBe(0.95);

    runtime.context.observeUsage(sessionId, {
      tokens: 950,
      contextWindow: 1_000,
      percent: 95,
    });

    expect(runtime.context.getPressureLevel(sessionId)).toBe("critical");
    expect(runtime.context.getCompactionWindowTurns()).toBe(5);
  });

  test("cost.getSummary returns zeroed state for untouched sessions and keeps per-session totals isolated", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-facade-cost-summary") });
    const sessionA = "runtime-facade-cost-a";
    const sessionB = "runtime-facade-cost-b";

    expect(runtime.cost.getSummary(sessionA)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      models: {},
      skills: {},
      tools: {},
      alerts: [],
      budget: {
        action: DEFAULT_BREWVA_CONFIG.infrastructure.costTracking.actionOnExceed,
        sessionExceeded: false,
        blocked: false,
      },
    });

    runtime.context.onTurnStart(sessionA, 1);
    runtime.tools.markCall(sessionA, "read");
    runtime.cost.recordAssistantUsage({
      sessionId: sessionA,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0002,
    });

    const summaryA = runtime.cost.getSummary(sessionA);
    const summaryB = runtime.cost.getSummary(sessionB);

    expect(summaryA.totalTokens).toBe(15);
    expect(summaryA.totalCostUsd).toBe(0.0002);
    expect(summaryA.models["test/model"]?.totalTokens).toBe(15);
    expect(summaryB).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      models: {},
      skills: {},
      tools: {},
      alerts: [],
      budget: {
        action: DEFAULT_BREWVA_CONFIG.infrastructure.costTracking.actionOnExceed,
        sessionExceeded: false,
        blocked: false,
      },
    });
  });
});
