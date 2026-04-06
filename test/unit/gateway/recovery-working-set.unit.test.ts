import { describe, expect, test } from "bun:test";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { resolveRecoveryWorkingSetBlock } from "../../../packages/brewva-gateway/src/runtime-plugins/recovery-working-set.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("recovery working set", () => {
  test("builds a typed recovery block from hosted transition posture and task state", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "recovery-working-set-session";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the pending answer after compaction",
    });
    runtime.authority.task.recordBlocker(sessionId, {
      message: "Pending review evidence",
      source: "unit_test",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "compaction_retry",
        status: "completed",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: null,
      },
    });

    const block = resolveRecoveryWorkingSetBlock(runtime, { sessionId });

    expect(block).not.toBeNull();
    expect(block?.id).toBe("recovery-working-set");
    expect(block?.category).toBe("constraint");
    expect(block?.content).toContain("[RecoveryWorkingSet]");
    expect(block?.content).toContain("latest_reason: compaction_retry");
    expect(block?.content).toContain("task_goal: Finish the pending answer after compaction");
    expect(block?.content).toContain("open_blockers: 1");
    expect(block?.content).toContain("resume_contract:");
  });

  test("omits the block when the session has no active recovery posture", () => {
    const runtime = createRuntimeFixture();
    const block = resolveRecoveryWorkingSetBlock(runtime, {
      sessionId: "no-recovery-working-set",
    });
    expect(block).toBeNull();
  });

  test("includes reasoning revert resume in the recovery working set posture", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "reasoning-revert-working-set";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Continue after restoring a prior reasoning checkpoint",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "reasoning_revert_resume",
        status: "completed",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: "reasoning_revert",
        error: null,
        breakerOpen: false,
        model: null,
      },
    });

    const block = resolveRecoveryWorkingSetBlock(runtime, { sessionId });

    expect(block).not.toBeNull();
    expect(block?.content).toContain("latest_reason: reasoning_revert_resume");
    expect(block?.content).toContain(
      "task_goal: Continue after restoring a prior reasoning checkpoint",
    );
  });
});
