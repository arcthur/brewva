import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  deriveSessionStatusSeedFromLifecycleSnapshot,
  deriveSessionStatusSeedFromFrame,
  deriveSessionStatusSeedFromHistory,
} from "../../../packages/brewva-gateway/src/daemon/internal/session-wire-status.js";

const SESSION_ID = asBrewvaSessionId("session-wire-status");

function createTurnInputFrame(frameId: string): Extract<SessionWireFrame, { type: "turn.input" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId,
    ts: 1,
    source: "live",
    durability: "durable",
    type: "turn.input",
    turnId: "turn-1",
    trigger: "user",
    promptText: "Inspect runtime status.",
  };
}

function createApprovalRequestedFrame(
  frameId: string,
): Extract<SessionWireFrame, { type: "approval.requested" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId,
    ts: 2,
    source: "live",
    durability: "durable",
    type: "approval.requested",
    turnId: "turn-1",
    requestId: "req-1",
    toolName: asBrewvaToolName("shell"),
    toolCallId: asBrewvaToolCallId("tool-1"),
    subject: "Run guarded command",
  };
}

function createApprovalDecidedFrame(
  frameId: string,
): Extract<SessionWireFrame, { type: "approval.decided" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId,
    ts: 3,
    source: "live",
    durability: "durable",
    type: "approval.decided",
    turnId: "turn-1",
    requestId: "req-1",
    decision: "accept",
    reason: "operator_accepted",
  };
}

function createTurnTransitionFrame(
  frameId: string,
  status: "entered" | "completed",
): Extract<SessionWireFrame, { type: "turn.transition" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId,
    ts: status === "entered" ? 4 : 5,
    source: "live",
    durability: "durable",
    type: "turn.transition",
    turnId: "turn-1",
    reason: "wal_recovery_resume",
    status,
    family: "recovery",
  };
}

function createTurnCommittedFrame(
  frameId: string,
): Extract<SessionWireFrame, { type: "turn.committed" }> {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: SESSION_ID,
    frameId,
    ts: 6,
    source: "live",
    durability: "durable",
    type: "turn.committed",
    turnId: "turn-1",
    attemptId: "attempt-1",
    status: "completed",
    assistantText: "Done.",
    toolOutputs: [],
  };
}

describe("session wire status seeds", () => {
  test("derives waiting approval from active approval history", () => {
    const seed = deriveSessionStatusSeedFromHistory(
      SESSION_ID,
      [createTurnInputFrame("turn-input"), createApprovalRequestedFrame("approval-requested")],
      "idle",
    );

    expect(seed).toEqual({
      state: "waiting_approval",
      reason: "approval_requested",
      detail: "Run guarded command",
    });
  });

  test("does not resurrect waiting approval after approval is decided", () => {
    const seed = deriveSessionStatusSeedFromHistory(
      SESSION_ID,
      [
        createTurnInputFrame("turn-input"),
        createApprovalRequestedFrame("approval-requested"),
        createApprovalDecidedFrame("approval-decided"),
      ],
      "idle",
    );

    expect(seed).toEqual({
      state: "running",
    });
  });

  test("does not resurrect restarting after recovery transition completes", () => {
    const seed = deriveSessionStatusSeedFromHistory(
      SESSION_ID,
      [
        createTurnInputFrame("turn-input"),
        createTurnTransitionFrame("recovery-entered", "entered"),
        createTurnTransitionFrame("recovery-completed", "completed"),
      ],
      "idle",
    );

    expect(seed).toEqual({
      state: "running",
    });
  });

  test("keeps completed recovery frames running on the live frame path", () => {
    const seed = deriveSessionStatusSeedFromFrame(
      createTurnTransitionFrame("recovery-completed", "completed"),
    );

    expect(seed).toEqual({
      state: "running",
    });
  });

  test("returns idle once the turn is committed after approval and recovery facts settle", () => {
    const seed = deriveSessionStatusSeedFromHistory(
      SESSION_ID,
      [
        createTurnInputFrame("turn-input"),
        createApprovalRequestedFrame("approval-requested"),
        createApprovalDecidedFrame("approval-decided"),
        createTurnTransitionFrame("recovery-entered", "entered"),
        createTurnTransitionFrame("recovery-completed", "completed"),
        createTurnCommittedFrame("turn-committed"),
      ],
      "idle",
    );

    expect(seed).toEqual({
      state: "idle",
      reason: undefined,
    });
  });

  test("seeds a restarting status from a producer-realistic recovering snapshot", () => {
    // The four-port producer emits `recovering` on both summary and execution while a
    // turn is suspended mid-recovery (see four-port-lifecycle.unit.test.ts). That is the
    // only posture this function seeds from the snapshot; waiting_approval and closed are
    // reconstructed from wire frames (covered by the history tests above), so the
    // function returns null for them and lets the frame-history seed win.
    expect(
      deriveSessionStatusSeedFromLifecycleSnapshot({
        sessionId: SESSION_ID,
        execution: {
          kind: "recovering",
          reason: "compaction_required",
          detail: "runtime.suspended",
        },
        recovery: {
          mode: "observed",
          latestReason: "compaction_required",
          latestStatus: "entered",
          pendingFamily: "recovery",
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: "evt-1",
          latestSourceEventType: "runtime.suspended",
          recentTransitions: ["compaction_required"],
        },
        tooling: { openToolCalls: [] },
        summary: {
          kind: "recovering",
          reason: "compaction_required",
          detail: "runtime.suspended",
        },
      }),
    ).toEqual({
      state: "restarting",
      reason: "compaction_required",
      detail: "runtime.suspended",
    });
  });

  test("declines to seed a running snapshot so the frame-history seed wins", () => {
    // Even an approval wait keeps a `running` kind on the snapshot (it carries no tool
    // identity), so the snapshot must not seed a status — the frame-history path holds
    // the real waiting_approval seed for approvals.
    expect(
      deriveSessionStatusSeedFromLifecycleSnapshot({
        sessionId: SESSION_ID,
        execution: { kind: "running", detail: "runtime_turn_active" },
        recovery: {
          mode: "idle",
          latestReason: null,
          latestStatus: "entered",
          pendingFamily: "approval",
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: "evt-1",
          latestSourceEventType: "runtime.suspended",
          recentTransitions: [],
        },
        tooling: { openToolCalls: [] },
        summary: { kind: "running", reason: null, detail: "runtime.suspended" },
      }),
    ).toBeNull();
  });
});
