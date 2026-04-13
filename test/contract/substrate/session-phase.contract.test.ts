import { describe, expect, test } from "bun:test";
import {
  SESSION_CRASH_POINTS,
  SESSION_PHASE_KINDS,
  SESSION_TERMINATION_REASONS,
  canResumeSessionPhase,
  isSessionPhaseActive,
  isSessionPhaseTerminal,
  type SessionPhase,
} from "@brewva/brewva-substrate";

describe("substrate session phase contract", () => {
  test("exports the C2 session phase vocabulary including approval and recovery states", () => {
    expect(SESSION_PHASE_KINDS).toEqual([
      "idle",
      "model_streaming",
      "tool_executing",
      "waiting_approval",
      "recovering",
      "crashed",
      "terminated",
    ]);
    expect(SESSION_CRASH_POINTS).toEqual([
      "model_streaming",
      "tool_executing",
      "wal_append",
      "checkpoint_write",
    ]);
    expect(SESSION_TERMINATION_REASONS).toEqual([
      "completed",
      "cancelled",
      "fatal_error",
      "host_closed",
    ]);
  });

  test("exposes helpers that distinguish active, resumable, and terminal phases", () => {
    const activePhase: SessionPhase = {
      kind: "tool_executing",
      toolCallId: "tool_123",
      toolName: "exec",
      turn: 4,
    };
    const crashedPhase: SessionPhase = {
      kind: "crashed",
      crashAt: "tool_executing",
      turn: 4,
      toolCallId: "tool_123",
      recoveryAnchor: "wal:evt_9",
    };
    const terminatedPhase: SessionPhase = {
      kind: "terminated",
      reason: "completed",
    };

    expect(isSessionPhaseActive(activePhase)).toBe(true);
    expect(isSessionPhaseTerminal(activePhase)).toBe(false);
    expect(canResumeSessionPhase(activePhase)).toBe(false);

    expect(isSessionPhaseActive(crashedPhase)).toBe(false);
    expect(isSessionPhaseTerminal(crashedPhase)).toBe(false);
    expect(canResumeSessionPhase(crashedPhase)).toBe(true);

    expect(isSessionPhaseActive(terminatedPhase)).toBe(false);
    expect(isSessionPhaseTerminal(terminatedPhase)).toBe(true);
    expect(canResumeSessionPhase(terminatedPhase)).toBe(false);

    const approvalPhase: SessionPhase = {
      kind: "waiting_approval",
      requestId: "approval_123",
      toolCallId: "tool_123",
      toolName: "exec",
      turn: 4,
    };
    const recoveringPhase: SessionPhase = {
      kind: "recovering",
      recoveryAnchor: "wal:evt_9",
      turn: 4,
    };

    expect(isSessionPhaseActive(approvalPhase)).toBe(false);
    expect(isSessionPhaseTerminal(approvalPhase)).toBe(false);
    expect(canResumeSessionPhase(approvalPhase)).toBe(false);

    expect(isSessionPhaseActive(recoveringPhase)).toBe(false);
    expect(isSessionPhaseTerminal(recoveringPhase)).toBe(false);
    expect(canResumeSessionPhase(recoveringPhase)).toBe(false);
  });
});
