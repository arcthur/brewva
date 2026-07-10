import { describe, expect, test } from "bun:test";
import {
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/context";
import {
  createHostedCompactionController,
  type HostedManualCompactOptions,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-telemetry.js";
import { requireDefined } from "../../helpers/assertions.js";
import { waitUntil } from "../../helpers/process.js";
import { createRuntimeConfig, createRuntimeFixture } from "../../helpers/runtime.js";

function controllerRuntime() {
  return createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.infrastructure.contextBudget.thresholds.hardRatio = 0.9;
      config.infrastructure.contextBudget.thresholds.advisoryRatio = 0.75;
      config.infrastructure.contextBudget.thresholds.headroomTokens = 1_000;
    }),
  });
}

describe("hosted auto-compaction controller — ineffective guard on the live path", () => {
  test("context() defers auto-compaction when recent committed reductions are ineffective", () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-ineffective";
    const usage = { tokens: 8_000, contextWindow: 10_000, percent: 80, maxOutputTokens: 1_000 };

    controller.turnStart({ sessionId, turnIndex: 10, timestamp: 1 });
    runtime.ops.context.lifecycle.onTurnStart(sessionId, 10);
    // Two old (post-cooldown) committed receipts that each reduced only ~5% — below
    // the 0.1 shrink floor — so the live auto path should defer rather than thrash.
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "c1",
      sourceTurn: 1,
      firstKeptEntryId: "e1",
      fromTokens: 10_000,
      toTokens: 9_600,
    });
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "c2",
      sourceTurn: 2,
      firstKeptEntryId: "e2",
      fromTokens: 10_000,
      toTokens: 9_500,
    });

    let compactCalled = false;
    controller.context({
      sessionId,
      usage,
      hasUI: true,
      idle: true,
      compact: () => {
        compactCalled = true;
      },
    });

    expect(compactCalled).toBe(false);
    const skipped = runtime.ops.events.records
      .query(sessionId, { type: CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE })
      .at(-1)?.payload;
    expect(skipped).toMatchObject({ reason: "compaction_ineffective" });
  });
});

describe("hosted auto-compaction controller — deferred commit ordering and breaker liveness", () => {
  const usage = { tokens: 8_000, contextWindow: 10_000, percent: 80, maxOutputTokens: 1_000 };

  function executeAutoAttempt(
    controller: ReturnType<typeof createHostedCompactionController>,
    sessionId: string,
  ): HostedManualCompactOptions {
    let request: HostedManualCompactOptions | undefined;
    controller.context({
      sessionId,
      usage,
      hasUI: true,
      idle: true,
      compact: (options) => {
        request = options;
      },
    });
    return requireDefined(request, "auto-compaction attempt did not execute");
  }

  test("session_compact commit before onComplete still lands exactly one auto.completed", async () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-deferred-completed";

    controller.turnStart({ sessionId, turnIndex: 3, timestamp: 1 });
    const request = executeAutoAttempt(controller, sessionId);

    // Managed deferred flow ordering (compaction-lifecycle finalize): the
    // session_compact hook commits — and clears execution state — BEFORE the
    // request's onComplete runs.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: { id: "cmp-deferred", summary: "compacted", toTokens: 200 },
    });
    request.onComplete?.();
    // A finalize that throws inside onComplete can reach the salvage path,
    // which invokes onComplete again — the receipt must not double-count.
    request.onComplete?.();

    const completed = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
    });
    expect(completed).toHaveLength(1);
    // The completion receipt carries the attempt's own pressure reason.
    const requested = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
    });
    expect(requested).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ reason: requested[0]?.payload?.reason });
    const failed = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
    });
    expect(failed).toHaveLength(0);
  });

  test("onComplete without a preceding session_compact still lands exactly one auto.completed", () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-active-branch-completed";

    controller.turnStart({ sessionId, turnIndex: 2, timestamp: 1 });
    const request = executeAutoAttempt(controller, sessionId);
    // Non-deferred / in-process compaction and the salvage path that fires
    // before the session_compact commit invoke onComplete WITHOUT the hook ever
    // parking an attempt id. The completion must still emit via the in-flight
    // attempt latch, and stay idempotent if onComplete re-runs.
    request.onComplete?.();
    request.onComplete?.();

    const completed = runtime.ops.events.records.query(sessionId, {
      type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
    });
    expect(completed).toHaveLength(1);
    expect(
      runtime.ops.events.records.query(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
      }),
    ).toHaveLength(0);
  });

  test("manual session_compact during an in-flight attempt emits no auto.completed and releases the in-flight latch", async () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-manual-interleave";

    controller.turnStart({ sessionId, turnIndex: 4, timestamp: 1 });
    executeAutoAttempt(controller, sessionId);

    // An extension/manual compaction lands while the auto attempt is still in
    // flight: it must clear the watchdog and in-flight latch without forging a
    // completion receipt for the auto attempt.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: { id: "cmp-manual", summary: "manual", toTokens: 100 },
      fromExtension: true,
    });

    expect(
      runtime.ops.events.records.query(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
      }),
    ).toHaveLength(0);
    // The latch is released: once the recent_compaction cooldown
    // (minTurnsBetween) has passed, renewed pressure may start a fresh attempt.
    // The budget clock is advanced explicitly — the controller's turn clock is
    // a monotonic counter, not a passthrough of turnIndex.
    controller.turnStart({ sessionId, turnIndex: 8, timestamp: 2 });
    runtime.ops.context.lifecycle.onTurnStart(sessionId, 8);
    executeAutoAttempt(controller, sessionId);
  });

  test("session shutdown drops a parked attempt so a late onComplete emits nothing", async () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-shutdown-parked";

    controller.turnStart({ sessionId, turnIndex: 6, timestamp: 1 });
    const request = executeAutoAttempt(controller, sessionId);
    // The commit parks the attempt id; the session then tears down before the
    // deferred flow's trailing onComplete runs.
    await controller.sessionCompact({
      sessionId,
      compactionEntry: { id: "cmp-shutdown", summary: "compacted", toTokens: 200 },
    });
    controller.sessionShutdown({ sessionId });
    request.onComplete?.();

    expect(
      runtime.ops.events.records.query(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
      }),
    ).toHaveLength(0);
  });

  test("a watchdog-failed attempt does not emit auto.completed when its commit lands late", async () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry, undefined, {
      autoCompactionWatchdogMs: 1,
    });
    const sessionId = "controller-watchdog-late-commit";

    controller.turnStart({ sessionId, turnIndex: 5, timestamp: 1 });
    const request = executeAutoAttempt(controller, sessionId);
    await waitUntil(
      () =>
        runtime.ops.events.records.query(sessionId, {
          type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
        }).length > 0,
      2_000,
      "watchdog did not record auto.failed",
    );

    await controller.sessionCompact({
      sessionId,
      compactionEntry: { id: "cmp-late", summary: "late", toTokens: 200 },
    });
    request.onComplete?.();

    expect(
      runtime.ops.events.records.query(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
    expect(
      runtime.ops.events.records.query(sessionId, {
        type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
      }),
    ).toHaveLength(0);
  });
});
