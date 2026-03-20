import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { setStaticContextPressureThresholds } from "../../fixtures/config.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

  test("session facade records and lists delegation runs", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-delegation-runs"),
    });
    const sessionId = "runtime-facade-delegation-runs-1";

    runtime.session.recordDelegationRun(sessionId, {
      runId: "delegation-1",
      profile: "reviewer",
      parentSessionId: sessionId,
      status: "running",
      createdAt: 10,
      updatedAt: 12,
      kind: "review",
      summary: "Reviewing patch boundaries.",
    });

    expect(runtime.session.getDelegationRun(sessionId, "delegation-1")).toMatchObject({
      runId: "delegation-1",
      status: "running",
      profile: "reviewer",
    });
    expect(runtime.session.listDelegationRuns(sessionId)).toHaveLength(1);
  });

  test("delegation run state rehydrates from lifecycle events and merge receipts", () => {
    const workspace = createTestWorkspace("runtime-facade-delegation-hydration");
    const sessionId = "runtime-facade-delegation-hydration-1";
    const writer = new BrewvaRuntime({ cwd: workspace });

    writer.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 100,
      payload: {
        runId: "delegation-hydrated-1",
        profile: "patch-worker",
        kind: "patch",
        boundary: "effectful",
        status: "running",
        deliveryMode: "supplemental",
        deliveryScopeId: "delegation-hydrated",
      },
    });
    writer.events.record({
      sessionId,
      type: "subagent_completed",
      timestamp: 120,
      payload: {
        runId: "delegation-hydrated-1",
        profile: "patch-worker",
        kind: "patch",
        childSessionId: "child-hydrated-1",
        boundary: "effectful",
        status: "completed",
        summary: "Produced a patch candidate.",
        artifactRefs: [
          {
            kind: "patch_file",
            path: ".orchestrator/subagent-patch-artifacts/hydrated/a.ts",
          },
        ],
        deliveryMode: "supplemental",
        deliveryScopeId: "delegation-hydrated",
        supplementalAppended: true,
        deliveryUpdatedAt: 121,
      },
    });
    writer.events.record({
      sessionId,
      type: "worker_results_applied",
      timestamp: 150,
      payload: {
        workerIds: ["delegation-hydrated-1"],
        appliedPaths: ["src/a.ts"],
      },
    });

    const reader = new BrewvaRuntime({ cwd: workspace });
    const runs = reader.session.listDelegationRuns(sessionId, {
      statuses: ["merged"],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId: "delegation-hydrated-1",
      status: "merged",
      workerSessionId: "child-hydrated-1",
      delivery: {
        mode: "supplemental",
        scopeId: "delegation-hydrated",
        supplementalAppended: true,
      },
    });
  });

  test("delegation timeout and delivery handoff metadata survive runtime restart", () => {
    const workspace = createTestWorkspace("runtime-facade-delegation-timeout");
    const sessionId = "runtime-facade-delegation-timeout-1";
    const writer = new BrewvaRuntime({ cwd: workspace });

    writer.events.record({
      sessionId,
      type: "subagent_spawned",
      timestamp: 200,
      payload: {
        runId: "delegation-timeout-1",
        profile: "reviewer",
        kind: "review",
        boundary: "safe",
        status: "running",
        deliveryMode: "supplemental",
        deliveryScopeId: "delegation-timeout",
      },
    });
    writer.events.record({
      sessionId,
      type: "subagent_failed",
      timestamp: 260,
      payload: {
        runId: "delegation-timeout-1",
        profile: "reviewer",
        kind: "review",
        boundary: "safe",
        status: "timeout",
        summary: "Child run timed out after 5s.",
        error: "timeout:5000",
        deliveryMode: "supplemental",
        deliveryScopeId: "delegation-timeout",
        supplementalAppended: true,
        deliveryUpdatedAt: 261,
      },
    });

    const reader = new BrewvaRuntime({ cwd: workspace });
    const run = reader.session.getDelegationRun(sessionId, "delegation-timeout-1");

    expect(run).toMatchObject({
      runId: "delegation-timeout-1",
      status: "timeout",
      summary: "Child run timed out after 5s.",
      delivery: {
        mode: "supplemental",
        scopeId: "delegation-timeout",
        supplementalAppended: true,
        updatedAt: 261,
      },
    });
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

  test("session.applyMergedWorkerResults publishes a merged worker patch and clears transient worker state", () => {
    const workspace = createTestWorkspace("runtime-facade-worker-apply");
    mkdirSync(join(workspace, "src"), { recursive: true });

    const beforeText = "export const facade = 'before';\n";
    const afterText = "export const facade = 'after';\n";
    const filePath = join(workspace, "src", "facade.ts");
    const artifactPath = join(
      workspace,
      ".orchestrator",
      "subagent-patch-artifacts",
      "facade-ps",
      "facade.ts",
    );

    writeFileSync(filePath, beforeText, "utf8");
    mkdirSync(join(workspace, ".orchestrator", "subagent-patch-artifacts", "facade-ps"), {
      recursive: true,
    });
    writeFileSync(artifactPath, afterText, "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "runtime-facade-worker-apply-1";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-a",
      status: "ok",
      summary: "worker apply candidate",
      patches: {
        id: "facade-ps",
        createdAt: Date.now(),
        changes: [
          {
            path: "src/facade.ts",
            action: "modify",
            beforeHash: sha256(beforeText),
            afterHash: sha256(afterText),
            artifactRef: ".orchestrator/subagent-patch-artifacts/facade-ps/facade.ts",
          },
        ],
      },
    });

    const report = runtime.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-runtime-facade-worker-apply",
    });

    expect(report.status).toBe("applied");
    expect(report.appliedPaths).toEqual(["src/facade.ts"]);
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
    expect(runtime.session.listWorkerResults(sessionId)).toHaveLength(0);
  });
});
