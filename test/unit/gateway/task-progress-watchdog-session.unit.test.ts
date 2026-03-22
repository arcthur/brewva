import { describe, expect, test } from "bun:test";
import { createGatewaySession } from "../../../packages/brewva-gateway/src/session/create-session.js";
import { TaskProgressWatchdog } from "../../../packages/brewva-gateway/src/session/task-progress-watchdog.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("gateway session watchdog integration", () => {
  test("records idle detection for a real gateway session id", async () => {
    const originalNow = Date.now;
    let now = 1_740_000_000_000;
    let scheduledCallback: (() => void) | null = null;
    const intervalHandle = setInterval(() => {}, 60_000);
    clearInterval(intervalHandle);

    Date.now = () => now;
    const result = await createGatewaySession({
      cwd: createTestWorkspace("gateway-watchdog-session"),
      config: createOpsRuntimeConfig(),
      managedToolMode: "direct",
    });

    try {
      const sessionId = result.session.sessionManager.getSessionId();

      const bootstrap = result.runtime.events.query(sessionId, {
        type: "session_bootstrap",
        last: 1,
      })[0];
      expect(bootstrap?.sessionId).toBe(sessionId);

      now = 1_740_000_000_100;
      result.runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Detect stalled work on a real gateway-backed session",
      });

      const watchdog = new TaskProgressWatchdog({
        runtime: result.runtime,
        sessionId,
        now: () => now,
        pollIntervalMs: 2_000,
        thresholdMs: 2_000,
        setIntervalFn: (callback) => {
          scheduledCallback = callback;
          return intervalHandle;
        },
        clearIntervalFn: () => {
          scheduledCallback = null;
        },
      });

      watchdog.start();
      expect(scheduledCallback).toEqual(expect.any(Function));

      now += 2_001;
      const triggerPoll =
        scheduledCallback ??
        (() => {
          throw new Error("expected scheduled watchdog poll");
        });
      triggerPoll();

      const detected = result.runtime.events.query(sessionId, {
        type: "task_stuck_detected",
        last: 1,
      })[0];
      expect(detected?.sessionId).toBe(sessionId);
      expect(detected?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 2_000,
        idleMs: 2_001,
      });

      watchdog.stop();
    } finally {
      Date.now = originalNow;
      result.session.dispose();
    }
  });
});
