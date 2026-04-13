import { describe, expect, test } from "bun:test";
import {
  advanceSessionPhase,
  canTransitionSessionPhase,
  type SessionPhase,
  type SessionPhaseEvent,
} from "@brewva/brewva-substrate";

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
      (phase, event) => advanceSessionPhase(phase, event),
      { kind: "idle" },
    );

    expect(finalPhase).toEqual({
      kind: "terminated",
      reason: "completed",
    });
  });

  test("enters a steady recovering state before returning to idle", () => {
    const crashed = advanceSessionPhase(
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
    const recovering = advanceSessionPhase(crashed, { type: "resume" });
    expect(recovering).toEqual({
      kind: "recovering",
      recoveryAnchor: "wal:tool_1",
      turn: 2,
    });
    expect(advanceSessionPhase(recovering, { type: "finish_recovery" })).toEqual({ kind: "idle" });
  });

  test("tracks approval as an explicit steady state", () => {
    const waitingApproval = advanceSessionPhase(
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
    expect(advanceSessionPhase(waitingApproval, { type: "approval_resolved" })).toEqual({
      kind: "idle",
    });
  });

  test("rejects invalid transitions", () => {
    expect(() => advanceSessionPhase({ kind: "idle" }, { type: "finish_tool_execution" })).toThrow(
      "invalid session phase transition",
    );
  });
});
