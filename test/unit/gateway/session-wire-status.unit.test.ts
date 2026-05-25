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
    decision: "approved",
    reason: "operator_approved",
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

  test("maps lifecycle snapshot summaries into session status seeds for replay seeding", () => {
    expect(
      deriveSessionStatusSeedFromLifecycleSnapshot({
        hydration: {
          status: "ready",
          issues: [],
        },
        execution: {
          kind: "waiting_approval",
          requestId: "req-1",
          toolCallId: asBrewvaToolCallId("tool-1"),
          toolName: asBrewvaToolName("shell"),
          reason: "approval_requested",
          detail: "Run guarded command",
        },
        recovery: {
          mode: "idle",
          latestReason: null,
          latestStatus: null,
          pendingFamily: null,
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: null,
          latestSourceEventType: null,
          recentTransitions: [],
        },
        approval: {
          status: "pending",
          pendingCount: 1,
          requestId: "req-1",
          toolCallId: asBrewvaToolCallId("tool-1"),
          toolName: asBrewvaToolName("shell"),
          subject: null,
        },
        tooling: {
          openToolCalls: [],
        },
        integrity: {
          status: "healthy",
          issues: [],
        },
        summary: {
          kind: "blocked",
          reason: "approval_requested",
          detail: "Run guarded command",
        },
      }),
    ).toEqual({
      state: "waiting_approval",
      reason: "approval_requested",
      detail: "Run guarded command",
    });

    expect(
      deriveSessionStatusSeedFromLifecycleSnapshot({
        hydration: {
          status: "ready",
          issues: [],
        },
        execution: {
          kind: "recovering",
          reason: "wal_recovery_resume",
          detail: undefined,
          family: "recovery",
        },
        recovery: {
          mode: "resumable",
          latestReason: "wal_recovery_resume",
          latestStatus: "entered",
          pendingFamily: "recovery",
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: "revert-1",
          latestSourceEventType: "reasoning_revert_recorded",
          recentTransitions: [],
        },
        approval: {
          status: "idle",
          pendingCount: 0,
          requestId: null,
          toolCallId: null,
          toolName: null,
          subject: null,
        },
        tooling: {
          openToolCalls: [],
        },
        integrity: {
          status: "healthy",
          issues: [],
        },
        summary: {
          kind: "recovering",
          reason: "wal_recovery_resume",
          detail: undefined,
        },
      }),
    ).toEqual({
      state: "restarting",
      reason: "wal_recovery_resume",
      detail: undefined,
    });

    expect(
      deriveSessionStatusSeedFromLifecycleSnapshot({
        hydration: {
          status: "ready",
          issues: [],
        },
        execution: {
          kind: "terminated",
          reason: "host_closed",
        },
        recovery: {
          mode: "idle",
          latestReason: null,
          latestStatus: null,
          pendingFamily: null,
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: null,
          latestSourceEventType: null,
          recentTransitions: [],
        },
        approval: {
          status: "idle",
          pendingCount: 0,
          requestId: null,
          toolCallId: null,
          toolName: null,
          subject: null,
        },
        tooling: {
          openToolCalls: [],
        },
        integrity: {
          status: "healthy",
          issues: [],
        },
        summary: {
          kind: "closed",
          reason: "host_closed",
          detail: null,
        },
      }),
    ).toEqual({
      state: "closed",
      reason: "host_closed",
    });
  });
});
