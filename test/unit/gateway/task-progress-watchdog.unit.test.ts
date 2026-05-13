import { describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import {
  TASK_PROGRESS_WATCHDOG_TEST_ONLY,
  TaskProgressWatchdog,
} from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/watchdog/task-progress-watchdog.js";
import { patchDateNow } from "../../helpers/global-state.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

describe("task progress watchdog", () => {
  test("records an idle diagnostic event when task progress stalls", () => {
    let now = 1_710_000_000_000;
    const restoreNow = patchDateNow(() => now);
    try {
      const runtime = createHostedTestRuntime({
        cwd: createTestWorkspace("watchdog-detect"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "watchdog-detect-1";

      now = 1_710_000_000_100;
      runtime.authority.task.spec.set(sessionId, {
        schema: "brewva.task.v1",
        goal: "Detect long-running idle periods",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLD_MS + 1;
      watchdog.poll();

      const state = runtime.inspect.task.state.get(sessionId);
      expect(state.blockers).toEqual([]);
      expect(state.status?.phase).not.toBe("blocked");

      const detected = runtime.inspect.events.records.query(sessionId, {
        type: "task_stuck_detected",
      });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLD_MS,
        baselineProgressAt: 1_710_000_000_100,
        detectedAt: 1_710_000_300_101,
        idleMs: TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLD_MS + 1,
        openItemCount: 0,
      });
      const adjudicated = runtime.inspect.events.records.query(sessionId, {
        type: "task_stall_adjudicated",
      });
      expect(adjudicated).toHaveLength(1);
      expect(adjudicated[0]?.payload).toMatchObject({
        schema: "brewva.task-stall-adjudication.v1",
        decision: "continue",
        source: "heuristic",
      });

      now += 60_000;
      watchdog.poll();
      expect(
        runtime.inspect.events.records.query(sessionId, { type: "task_stuck_detected" }),
      ).toHaveLength(1);
      expect(
        runtime.inspect.events.records.query(sessionId, { type: "task_stall_adjudicated" }),
      ).toHaveLength(1);
    } finally {
      restoreNow();
    }
  });

  test("ignores sessions without explicit task state", async () => {
    let now = 1_719_000_000_000;
    const restoreNow = patchDateNow(() => now);
    try {
      const runtime = createHostedTestRuntime({
        cwd: createTestWorkspace("watchdog-no-task-state"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "watchdog-no-task-state-1";

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLD_MS + 1;
      watchdog.poll();

      expect(
        runtime.inspect.events.records.query(sessionId, { type: "task_stuck_detected" }),
      ).toEqual([]);
    } finally {
      restoreNow();
    }
  });

  test("start schedules a single poller, stop clears it, and threshold sanitization clamps overrides", async () => {
    let now = 1_725_000_000_000;
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelayMs = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const intervalHandle = setInterval(() => {}, 60_000);
    clearInterval(intervalHandle);

    const restoreNow = patchDateNow(() => now);
    try {
      const runtime = createHostedTestRuntime({
        cwd: createTestWorkspace("watchdog-lifecycle"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "watchdog-lifecycle-1";

      now = 1_725_000_000_100;
      runtime.authority.task.spec.set(sessionId, {
        schema: "brewva.task.v1",
        goal: "Exercise worker-local watchdog lifecycle wiring",
      });

      expect(TASK_PROGRESS_WATCHDOG_TEST_ONLY.sanitizeDelayMs(250, 5_000)).toBe(1_000);

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
        pollIntervalMs: 250,
        thresholdMs: 250,
        setIntervalFn: (callback, delayMs) => {
          startCalls += 1;
          scheduledCallback = callback;
          scheduledDelayMs = delayMs;
          return intervalHandle;
        },
        clearIntervalFn: (handle) => {
          expect(handle).toBe(intervalHandle);
          stopCalls += 1;
        },
      });

      watchdog.start();
      watchdog.start();
      expect(startCalls).toBe(1);
      expect(scheduledDelayMs).toBe(1_000);
      expect(typeof scheduledCallback).toBe("function");

      now += 1_001;
      const triggerPoll =
        scheduledCallback ??
        (() => {
          throw new Error("expected scheduled watchdog poll");
        });
      triggerPoll();

      const detected = runtime.inspect.events.records.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 1_000,
        idleMs: 1_001,
      });
      const adjudicated = runtime.inspect.events.records.query(sessionId, {
        type: "task_stall_adjudicated",
        last: 1,
      })[0];
      expect(adjudicated?.payload).toMatchObject({
        schema: "brewva.task-stall-adjudication.v1",
        decision: "continue",
      });

      await watchdog.stop();
      await watchdog.stop();
      expect(stopCalls).toBe(1);
    } finally {
      restoreNow();
    }
  });

  test("records hook-backed adjudication when a custom stall adjudicator is provided", () => {
    let now = 1_726_000_000_000;
    const restoreNow = patchDateNow(() => now);
    try {
      const runtime = createHostedTestRuntime({
        cwd: createTestWorkspace("watchdog-hook-adjudication"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "watchdog-hook-adjudication-1";

      now = 1_726_000_000_100;
      runtime.authority.task.spec.set(sessionId, {
        schema: "brewva.task.v1",
        goal: "Exercise hook-backed stall adjudication",
      });
      runtime.authority.task.blockers.record(sessionId, {
        message: "Awaiting operator decision on retry scope",
        source: "unit_test",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime,
        sessionId,
        now: () => now,
        adjudicator: (packet) => ({
          decision: "steer",
          rationale: `Hook inspected ${packet.task.blockerCount} blocker(s).`,
          signalSummary: ["custom_hook"],
          source: "hook",
        }),
      });

      now += TASK_PROGRESS_WATCHDOG_TEST_ONLY.DEFAULT_THRESHOLD_MS + 1;
      watchdog.poll();

      const adjudicated = runtime.inspect.events.records.query(sessionId, {
        type: "task_stall_adjudicated",
        last: 1,
      })[0];
      expect(adjudicated?.payload).toMatchObject({
        schema: "brewva.task-stall-adjudication.v1",
        decision: "steer",
        source: "hook",
        rationale: "Hook inspected 1 blocker(s).",
        signalSummary: ["custom_hook"],
      });
    } finally {
      restoreNow();
    }
  });
});
