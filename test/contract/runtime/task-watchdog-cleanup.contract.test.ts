import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createOperatorRuntimePort } from "@brewva/brewva-runtime";
import { patchDateNow } from "../../helpers/global-state.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("task watchdog cleanup", () => {
  test("records a cleared event on turn start after semantic progress resumes", () => {
    let now = 1_730_000_000_000;
    const restoreNow = patchDateNow(() => now);
    try {
      const runtime = new BrewvaRuntime({
        cwd: createTestWorkspace("watchdog-cleanup"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "watchdog-cleanup-1";

      now = 1_730_000_000_100;
      runtime.authority.task.spec.set(sessionId, {
        schema: "brewva.task.v1",
        goal: "Resume work after a previous stall",
      });

      now = 1_730_000_000_200;
      createOperatorRuntimePort(runtime).operator.session.stall.poll(sessionId, {
        now,
        thresholdMs: 1_000,
      });
      expect(
        runtime.inspect.events.records.query(sessionId, { type: "task_stuck_detected" }),
      ).toHaveLength(0);

      now = 1_730_000_001_300;
      createOperatorRuntimePort(runtime).operator.session.stall.poll(sessionId, {
        now,
        thresholdMs: 1_000,
      });
      expect(
        runtime.inspect.events.records.query(sessionId, { type: "task_stuck_detected" }),
      ).toHaveLength(1);

      now = 1_730_000_001_400;
      runtime.authority.task.items.add(sessionId, {
        text: "Semantic progress resumes with a new task item",
      });

      now = 1_730_000_001_500;
      createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(sessionId, 1);

      const clearEvent = runtime.inspect.events.records.query(sessionId, {
        type: "task_stuck_cleared",
        last: 1,
      })[0];
      expect(clearEvent?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        detectedAt: 1_730_000_001_300,
        clearedAt: 1_730_000_001_500,
        resumedProgressAt: 1_730_000_001_400,
      });
    } finally {
      restoreNow();
    }
  });
});
