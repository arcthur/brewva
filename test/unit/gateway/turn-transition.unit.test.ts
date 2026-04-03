import { describe, expect, test } from "bun:test";
import {
  getHostedTurnTransitionCoordinator,
  projectHostedTransitionSnapshot,
  recordSessionTurnTransition,
} from "../../../packages/brewva-gateway/src/session/turn-transition.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("hosted turn transition coordinator", () => {
  test("maps compaction gate and approval runtime facts into hosted transitions", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-mapping";
    getHostedTurnTransitionCoordinator(runtime);

    runtime.events.record({
      sessionId,
      turn: 4,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 4,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
      },
    });

    const transitions = runtime.events.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.payload).toMatchObject({
      reason: "compaction_gate_blocked",
      status: "entered",
      family: "context",
      sourceEventType: "context_compaction_gate_blocked_tool",
      sequence: 1,
    });
    expect(transitions[1]?.payload).toMatchObject({
      reason: "effect_commitment_pending",
      status: "entered",
      family: "approval",
      sourceEventType: "effect_commitment_approval_requested",
      sequence: 2,
    });
  });

  test("deduplicates repeated gate-blocked and approval-completion runtime facts into one enter/complete pair", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-dedup";
    getHostedTurnTransitionCoordinator(runtime);

    runtime.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "grep",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_cleared",
      payload: {
        reason: "session_compact_performed",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_cleared",
      payload: {
        reason: "duplicate_clear",
      },
    });

    runtime.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_decided",
      payload: {
        requestId: "approval-1",
        decision: "accept",
      },
    });
    runtime.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_consumed",
      payload: {
        requestId: "approval-1",
      },
    });

    const transitions = runtime.events.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(4);
    expect(transitions.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        reason: "compaction_gate_blocked",
        status: "entered",
        sequence: 1,
      }),
      expect.objectContaining({
        reason: "compaction_gate_blocked",
        status: "completed",
        sequence: 2,
      }),
      expect.objectContaining({
        reason: "effect_commitment_pending",
        status: "entered",
        sequence: 3,
      }),
      expect.objectContaining({
        reason: "effect_commitment_pending",
        status: "completed",
        sequence: 4,
        sourceEventType: "effect_commitment_approval_decided",
      }),
    ]);
  });

  test("opens and resets recovery breakers from transition history", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-breakers";
    const coordinator = getHostedTurnTransitionCoordinator(runtime);

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "failed",
      attempt: 1,
      error: "resume failed",
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "failed",
      attempt: 2,
      error: "resume failed",
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "failed",
      attempt: 3,
      error: "resume failed",
    });

    let snapshot = coordinator.getSnapshot(sessionId);
    expect(snapshot.sequence).toBe(3);
    expect(snapshot.consecutiveFailuresByReason.compaction_retry).toBe(3);
    expect(snapshot.breakerOpenByReason.compaction_retry).toBe(true);

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "completed",
      attempt: 4,
    });

    snapshot = coordinator.getSnapshot(sessionId);
    expect(snapshot.sequence).toBe(4);
    expect(snapshot.consecutiveFailuresByReason.compaction_retry).toBe(0);
    expect(snapshot.breakerOpenByReason.compaction_retry).toBe(false);
    expect(snapshot.latest).toMatchObject({
      reason: "compaction_retry",
      status: "completed",
      attempt: 4,
    });
  });

  test("tracks operator-visible governance facts for withheld-error cutovers", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-operator-visible";
    const coordinator = getHostedTurnTransitionCoordinator(runtime);

    const checkpoint = coordinator.captureOperatorVisibleCheckpoint(sessionId);
    expect(coordinator.hasOperatorVisibleFactSince(sessionId, checkpoint)).toBe(false);

    runtime.events.record({
      sessionId,
      type: "tool_call_blocked",
      payload: {
        toolName: "exec",
      },
    });

    expect(coordinator.hasOperatorVisibleFactSince(sessionId, checkpoint)).toBe(true);
    expect(coordinator.getSnapshot(sessionId).operatorVisibleFactGeneration).toBe(1);
  });

  test("projects hosted transition snapshots directly from persisted session events", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-projection";

    runtime.events.record({
      sessionId,
      type: "tool_call_blocked",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "compaction_retry",
        status: "failed",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: "resume_failed",
        breakerOpen: false,
        model: null,
      },
    });

    const snapshot = projectHostedTransitionSnapshot(runtime.events.queryStructured(sessionId));
    expect(snapshot.operatorVisibleFactGeneration).toBe(1);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.latest).toMatchObject({
      reason: "compaction_retry",
      status: "failed",
      attempt: 1,
    });
    expect(snapshot.consecutiveFailuresByReason.compaction_retry).toBe(1);
  });
});
