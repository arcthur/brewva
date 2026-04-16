import { describe, expect, test } from "bun:test";
import {
  advanceSessionPhaseResult,
  canTransitionSessionPhase,
  type SessionPhase,
  type SessionPhaseEvent,
} from "@brewva/brewva-substrate";

function expectPhaseTransition(phase: SessionPhase, event: SessionPhaseEvent): SessionPhase {
  const result = advanceSessionPhaseResult(phase, event);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.phase;
}

describe("substrate session phase machine", () => {
  test("advances through the execution-only lifecycle", () => {
    const lifecycle: SessionPhaseEvent[] = [
      { type: "start_model_stream", modelCallId: "model_1", turn: 1 },
      { type: "finish_model_stream" },
      { type: "start_tool_execution", toolCallId: "tool_1", toolName: "read", turn: 1 },
      { type: "finish_tool_execution" },
      { type: "terminate", reason: "completed" },
    ];

    const finalPhase = lifecycle.reduce<SessionPhase>(
      (phase, event) => expectPhaseTransition(phase, event),
      { kind: "idle" },
    );

    expect(finalPhase).toEqual({
      kind: "terminated",
      reason: "completed",
    });
  });

  test("enters a steady recovering state before returning to idle", () => {
    const crashed = expectPhaseTransition(
      { kind: "tool_executing", toolCallId: "tool_1", toolName: "write", turn: 2 },
      {
        type: "crash",
        crashAt: "tool_executing",
        recoveryAnchor: "wal:tool_1",
      },
    );

    expect(crashed).toEqual({
      kind: "crashed",
      crashAt: "tool_executing",
      turn: 2,
      toolCallId: "tool_1",
      recoveryAnchor: "wal:tool_1",
    });
    expect(canTransitionSessionPhase(crashed, { type: "resume" })).toBe(true);
    const recovering = expectPhaseTransition(crashed, { type: "resume" });
    expect(recovering).toEqual({
      kind: "recovering",
      recoveryAnchor: "wal:tool_1",
      turn: 2,
    });
    expect(expectPhaseTransition(recovering, { type: "finish_recovery" })).toEqual({
      kind: "idle",
    });
  });

  test("tracks approval as an explicit steady state", () => {
    const waitingApproval = expectPhaseTransition(
      { kind: "tool_executing", toolCallId: "tool_1", toolName: "write", turn: 2 },
      {
        type: "wait_for_approval",
        requestId: "approval_1",
      },
    );

    expect(waitingApproval).toEqual({
      kind: "waiting_approval",
      requestId: "approval_1",
      toolCallId: "tool_1",
      toolName: "write",
      turn: 2,
    });
    expect(expectPhaseTransition(waitingApproval, { type: "approval_resolved" })).toEqual({
      kind: "idle",
    });
  });

  test("rejects invalid transitions", () => {
    expect(advanceSessionPhaseResult({ kind: "idle" }, { type: "finish_tool_execution" })).toEqual({
      ok: false,
      error: "invalid session phase transition",
    });
  });
});
