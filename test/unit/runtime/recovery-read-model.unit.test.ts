import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId, type TaskState } from "@brewva/brewva-runtime";
import { runRecoveryContextPipeline } from "../../../packages/brewva-runtime/src/context/read-models.js";
import {
  deriveDuplicateSideEffectSuppressionCount,
  deriveRecoveryCanonicalization,
} from "../../../packages/brewva-runtime/src/recovery/read-model.js";
import type { RuntimeKernelContext } from "../../../packages/brewva-runtime/src/runtime-kernel.js";
import { RuntimeSessionStateStore } from "../../../packages/brewva-runtime/src/services/session-state.js";

function emptyTaskState(goal?: string): TaskState {
  return {
    ...(goal
      ? {
          spec: {
            schema: "brewva.task.v1",
            goal,
          },
        }
      : {}),
    items: [],
    blockers: [],
    updatedAt: null,
  };
}

function createPipelineKernel(input: {
  events: ReturnType<RuntimeKernelContext["eventStore"]["list"]>;
  taskState?: TaskState;
  onListEvents?: () => void;
}): RuntimeKernelContext {
  return {
    eventStore: {
      list: () => {
        input.onListEvents?.();
        return input.events;
      },
    },
    sessionState: new RuntimeSessionStateStore(),
    getTaskState: () => input.taskState ?? emptyTaskState(),
  } as unknown as RuntimeKernelContext;
}

describe("recovery read model", () => {
  test("derives active skill degradation directly from tape events before hydration state exists", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-skill-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "skill_activated",
        timestamp: 1,
        turn: 1,
        payload: {
          skillName: "design",
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "degraded",
      degradedReason: "active_skill_without_terminal_receipt",
      reasons: ["active_skill_without_terminal_receipt"],
      openToolCalls: [],
      openTurns: [],
    });
  });

  test("reuses a durable unclean-shutdown receipt as the canonical pre-hydration signal", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "degraded",
      degradedReason: "open_turn_without_terminal_receipt",
      reasons: ["open_turn_without_terminal_receipt"],
      openToolCalls: [],
      openTurns: [
        {
          turn: 1,
          startedAt: 1,
          eventId: "ev-turn-start-1",
        },
      ],
    });
  });

  test("lets later recovery transitions supersede a persisted unclean-shutdown diagnostic", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
      {
        id: "ev-transition-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "session_turn_transition",
        timestamp: 6,
        turn: 2,
        payload: {
          reason: "wal_recovery_resume",
          status: "entered",
          family: "recovery",
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "resumable",
      degradedReason: null,
      reasons: [],
      openToolCalls: [],
      openTurns: [],
    });
  });

  test("counts duplicate side-effect suppression from durable effect-commitment replay guards only", () => {
    expect(
      deriveDuplicateSideEffectSuppressionCount([
        {
          id: "ev-blocked-1",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 10,
          turn: 2,
          payload: {
            toolName: "exec",
            reason: "effect_commitment_request_in_flight:req-1",
          },
        },
        {
          id: "ev-blocked-2",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 11,
          turn: 2,
          payload: {
            toolName: "exec",
            reason: "effect_commitment_operator_approval_consumed:req-1",
          },
        },
        {
          id: "ev-blocked-3",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 12,
          turn: 2,
          payload: {
            toolName: "read",
            reason: "Tool 'read' called with identical arguments 3 times consecutively.",
          },
        },
      ]),
    ).toBe(2);
  });

  test("recovery context pipeline reuses canonical open tool calls for the working set", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-open-tools");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-tool-start-1",
          sessionId,
          type: "tool_execution_start",
          timestamp: 10,
          turn: 2,
          payload: {
            toolCallId: "tc-read",
            toolName: "read",
          },
        },
        {
          id: "ev-transition-1",
          sessionId,
          type: "session_turn_transition",
          timestamp: 11,
          turn: 2,
          payload: {
            reason: "wal_recovery_resume",
            status: "entered",
            family: "recovery",
            sourceEventId: "ev-tool-start-1",
            sourceEventType: "tool_execution_start",
          },
        },
        {
          id: "ev-blocked-1",
          sessionId,
          type: "tool_call_blocked",
          timestamp: 12,
          turn: 2,
          payload: {
            toolName: "exec",
            reason: "effect_commitment_request_in_flight:req-1",
          },
        },
      ],
      taskState: emptyTaskState("Resume without replaying open tool effects"),
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
    });

    expect(result.canonicalization).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "open_tool_calls_without_terminal_receipt",
      }),
    );
    expect(result.posture).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "open_tool_calls_without_terminal_receipt",
      }),
    );
    expect(result.transitionState).toEqual(
      expect.objectContaining({
        latestReason: "wal_recovery_resume",
        latestStatus: "entered",
        pendingFamily: "recovery",
        latestSourceEventId: "ev-tool-start-1",
        latestSourceEventType: "tool_execution_start",
      }),
    );
    expect(result.duplicateSideEffectSuppressionCount).toBe(1);
    expect(result.workingSet).toEqual(
      expect.objectContaining({
        taskGoal: "Resume without replaying open tool effects",
        openToolCalls: 1,
      }),
    );
  });

  test("recovery context pipeline reuses one event tape read for baseline and posture", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-single-event-read");
    let listCalls = 0;
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-input-1",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 1,
          turn: 1,
          payload: {
            turnId: "turn-1",
            trigger: "user_submit",
            promptText: "Keep pipeline event reads single-pass.",
          },
        },
      ],
      onListEvents: () => {
        listCalls += 1;
      },
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
    });

    expect(listCalls).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.baselineState.degradedReason).toBeNull();
    expect(result.posture.mode).toBe("idle");
  });

  test("recovery context pipeline feeds history-view degradation into posture", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-history-view");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-input-1",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 1,
          turn: 1,
          payload: {
            turnId: "turn-1",
            trigger: "user_submit",
            promptText: "x".repeat(2_000),
          },
        },
        {
          id: "ev-render-1",
          sessionId,
          type: "turn_render_committed",
          timestamp: 2,
          turn: 1,
          payload: {
            turnId: "turn-1",
            attemptId: "attempt-1",
            status: "completed",
            assistantText: "y".repeat(2_000),
            toolOutputs: [],
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
      maxBaselineTokens: 1,
    });

    expect(result.baselineState).toEqual(
      expect.objectContaining({
        degradedReason: "exact_history_over_budget",
        postureMode: "diagnostic_only",
      }),
    );
    expect(result.posture).toEqual(
      expect.objectContaining({
        mode: "diagnostic_only",
        degradedReason: "exact_history_over_budget",
      }),
    );
    expect(result.workingSet).toBeUndefined();
  });
});
