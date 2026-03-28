import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, buildTaskStuckDetectedPayload } from "@brewva/brewva-runtime";
import {
  adjudicateTaskStallPacket,
  buildTaskStallInspectionPacket,
  maybeAdjudicateLatestTaskStall,
} from "../../../packages/brewva-gateway/src/session/task-stall-adjudication.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("task stall adjudication", () => {
  test("builds an inspection packet from task, verification, and recent failure signals", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("stall-inspection-packet"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "stall-inspection-packet-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Repair the failing verification path",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "Awaiting targeted retry strategy",
      source: "unit_test",
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "patch-worker-1",
      status: "ok",
      summary: "Patch result is ready for parent review.",
    });
    runtime.events.record({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 150,
      payload: {
        toolName: "exec",
        verdict: "fail",
        channelSuccess: false,
        failureClass: "execution",
      },
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 160,
      payload: {
        outcome: "fail",
        level: "standard",
        failedChecks: ["tests"],
        evidenceFreshness: "fresh",
      },
    });

    const packet = buildTaskStallInspectionPacket({
      runtime,
      sessionId,
      detected: buildTaskStuckDetectedPayload({
        thresholdMs: 300_000,
        baselineProgressAt: 100,
        detectedAt: 400_100,
        idleMs: 400_000,
        openItemCount: 0,
      }),
    });

    expect(packet.task.goal).toBe("Repair the failing verification path");
    expect(packet.task.blockers).toEqual(["Awaiting targeted retry strategy"]);
    expect(packet.verification.lastOutcome).toBe("fail");
    expect(packet.verification.failedChecks).toEqual(["tests"]);
    expect(packet.signals.pendingWorkerResults).toBe(1);
    expect(packet.signals.recentToolFailures).toEqual([
      {
        toolName: "exec",
        verdict: "fail",
        failureClass: "execution",
        timestamp: 150,
      },
    ]);
  });

  test("prefers compact_recommended when tape pressure is already high", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("stall-compact-recommended"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "stall-compact-recommended-1";
    const highThreshold = runtime.events.getTapePressureThresholds().high;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Exercise high-pressure stall adjudication",
    });
    for (let index = 0; index <= highThreshold; index += 1) {
      runtime.events.record({
        sessionId,
        type: "custom_probe_event",
        payload: { index },
      });
    }

    const packet = buildTaskStallInspectionPacket({
      runtime,
      sessionId,
      detected: buildTaskStuckDetectedPayload({
        thresholdMs: 300_000,
        baselineProgressAt: 100,
        detectedAt: 500_100,
        idleMs: 400_000,
        openItemCount: 0,
      }),
    });

    expect(packet.tape.pressure).toBe("high");
    expect(adjudicateTaskStallPacket(packet)).toMatchObject({
      decision: "compact_recommended",
      source: "heuristic",
    });
  });

  test("records a single adjudication event for the latest detected stall", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("stall-adjudication-record"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "stall-adjudication-record-1";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Exercise durable stall adjudication",
    });
    runtime.task.recordBlocker(sessionId, {
      message: "Need user confirmation before retrying the fix",
      source: "unit_test",
    });
    runtime.events.record({
      sessionId,
      type: "task_stuck_detected",
      timestamp: 400_100,
      payload: {
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 300_000,
        baselineProgressAt: 100,
        detectedAt: 400_100,
        idleMs: 400_000,
        openItemCount: 0,
      },
    });

    const first = maybeAdjudicateLatestTaskStall({
      runtime,
      sessionId,
      now: () => 400_200,
    });
    const second = maybeAdjudicateLatestTaskStall({
      runtime,
      sessionId,
      now: () => 400_300,
    });

    expect(first).toMatchObject({
      decision: "nudge",
      source: "heuristic",
    });
    expect(second).toBeNull();
    expect(runtime.events.query(sessionId, { type: "task_stall_adjudicated" })).toHaveLength(1);
  });
});
