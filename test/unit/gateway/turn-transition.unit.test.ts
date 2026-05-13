import { describe, expect, test } from "bun:test";
import { createHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  HostedTransitionGateError,
  TURN_TRANSITION_TEST_ONLY,
  getHostedTurnTransitionCoordinator,
  projectHostedTransitionSnapshot,
  recordSessionTurnTransition,
} from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/turn-transition.js";
import { buildToolCallBlockedPayload } from "../../helpers/events.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("hosted turn transition coordinator", () => {
  test("maps compaction gate and approval runtime facts into hosted transitions", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-mapping";
    getHostedTurnTransitionCoordinator(runtime);

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 4,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "exec",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 4,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
      },
    });

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
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

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "exec",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_blocked_tool",
      payload: {
        toolName: "grep",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_cleared",
      payload: {
        reason: "session_compact_performed",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "context_compaction_gate_cleared",
      payload: {
        reason: "duplicate_clear",
      },
    });

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_decided",
      payload: {
        requestId: "approval-1",
        decision: "accept",
      },
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 3,
      type: "effect_commitment_approval_consumed",
      payload: {
        requestId: "approval-1",
      },
    });

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
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
      status: "entered",
      attempt: 1,
    });
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
      status: "entered",
      attempt: 2,
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
      status: "entered",
      attempt: 3,
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "failed",
      attempt: 3,
      error: "resume failed",
    });

    let snapshot = coordinator.getSnapshot(sessionId);
    expect(snapshot.sequence).toBe(6);
    expect(snapshot.consecutiveFailuresByReason.compaction_retry).toBe(3);
    expect(snapshot.breakerOpenByReason.compaction_retry).toBe(true);

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "entered",
      attempt: 4,
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "completed",
      attempt: 4,
    });

    snapshot = coordinator.getSnapshot(sessionId);
    expect(snapshot.sequence).toBe(8);
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

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "tool_call_blocked",
      payload: buildToolCallBlockedPayload(),
    });

    expect(coordinator.hasOperatorVisibleFactSince(sessionId, checkpoint)).toBe(true);
    expect(coordinator.getSnapshot(sessionId).operatorVisibleFactGeneration).toBe(1);
  });

  test("projects hosted transition snapshots directly from persisted session events", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-projection";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "tool_call_blocked",
      payload: buildToolCallBlockedPayload(),
    });
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
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

    const snapshot = projectHostedTransitionSnapshot(
      runtime.inspect.events.records.queryStructured(sessionId),
    );
    expect(snapshot.operatorVisibleFactGeneration).toBe(1);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.latest).toMatchObject({
      reason: "compaction_retry",
      status: "failed",
      attempt: 1,
    });
    expect(snapshot.consecutiveFailuresByReason.compaction_retry).toBe(1);
  });

  test("recognizes reasoning revert resume as a recovery transition reason", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-reasoning-revert";

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "reasoning_revert_resume",
      status: "entered",
      sourceEventType: "reasoning_revert",
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "reasoning_revert_resume",
      status: "completed",
      sourceEventType: "reasoning_revert",
    });

    const snapshot = projectHostedTransitionSnapshot(
      runtime.inspect.events.records.queryStructured(sessionId),
    );
    expect(snapshot.latest).toMatchObject({
      reason: "reasoning_revert_resume",
      status: "completed",
      family: "recovery",
      sourceEventType: "reasoning_revert",
    });
  });

  test("tracks the active hosted turn from durable turn receipts without rescanning the full session", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-active-turn";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 7,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-7",
        trigger: "user",
        promptText: "hello",
      },
    });

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "entered",
      attempt: 1,
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "failed",
      attempt: 1,
      error: "resume failed",
    });

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      turn: 7,
      type: "turn_render_committed",
      payload: {
        turnId: "turn-7",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "done",
        toolOutputs: [],
      },
    });

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "provider_fallback_retry",
      status: "entered",
      attempt: 2,
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "provider_fallback_retry",
      status: "failed",
      attempt: 2,
      error: "provider failed",
    });

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(4);
    expect(transitions[0]?.turn).toBe(7);
    expect(transitions[1]?.turn).toBe(7);
    expect(transitions[2]?.turn).toBeUndefined();
    expect(transitions[3]?.turn).toBeUndefined();
  });

  test("rejects duplicate entered transitions for an already active reason", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-duplicate-entered";

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "entered",
    });

    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "compaction_retry",
        status: "entered",
      });
    }).toThrow(HostedTransitionGateError);

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(1);
  });

  test("rejects completed transitions when no active entered transition exists", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-missing-entered";

    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "provider_fallback_retry",
        status: "completed",
      });
    }).toThrow(HostedTransitionGateError);

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(0);
  });

  test("rejects reason and family mismatches at the transition gate", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-family-mismatch";

    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "effect_commitment_pending",
        family: "recovery",
        status: "entered",
      });
    }).toThrow(HostedTransitionGateError);

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(0);
  });

  test("rejects new entered transitions after the session has closed", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-after-close";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_shutdown",
      payload: {
        reason: "host_closed",
      },
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId).summary.kind).toBe("closed");
    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "compaction_retry",
        status: "entered",
      });
    }).toThrow(HostedTransitionGateError);

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(0);
  });

  test("rebuilds gate state from persisted transitions when live event subscriptions are unavailable", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-persisted-rebuild";

    Object.assign(runtime.inspect.events, {
      subscribe() {
        return () => undefined;
      },
    });

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "entered",
      sourceEventId: "compact-1",
      sourceEventType: "session_compact",
    });

    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "compaction_retry",
        status: "completed",
        sourceEventId: "compact-1",
        sourceEventType: "session_compact",
      });
    }).not.toThrow();

    const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "session_turn_transition",
    });
    expect(transitions).toHaveLength(2);
    expect(transitions.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "compaction_retry",
          status: "entered",
          sourceEventId: "compact-1",
        }),
        expect.objectContaining({
          reason: "compaction_retry",
          status: "completed",
          sourceEventId: "compact-1",
        }),
      ]),
    );
  });

  test("hydrates transition state once and folds newly recorded events incrementally", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-hydrate-once";
    let queryStructuredCalls = 0;
    const originalQueryStructured = runtime.inspect.events.records.queryStructured.bind(
      runtime.inspect.events.records,
    );
    Object.assign(runtime.inspect.events.records, {
      queryStructured(
        querySessionId: string,
        query?: Parameters<typeof originalQueryStructured>[1],
      ) {
        queryStructuredCalls += 1;
        return originalQueryStructured(querySessionId, query);
      },
    });

    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "entered",
    });
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "compaction_retry",
      status: "completed",
    });

    expect(queryStructuredCalls).toBe(1);
  });

  test("checks for terminal shutdown receipts without rebuilding the lifecycle aggregate", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "turn-transition-shutdown-query";

    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_shutdown",
      payload: {
        reason: "host_closed",
      },
    });

    Object.assign(runtime.inspect.lifecycle, {
      getSnapshot() {
        throw new Error("lifecycle snapshot should not be consulted for entered gate checks");
      },
    });

    expect(() => {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "compaction_retry",
        status: "entered",
      });
    }).toThrow(HostedTransitionGateError);
  });

  test("flushes all corrupted reason-level active transition keys on completion", () => {
    const state = TURN_TRANSITION_TEST_ONLY.createEmptyState();
    state.hydrated = true;

    TURN_TRANSITION_TEST_ONLY.foldTransition(state, {
      reason: "compaction_gate_blocked",
      status: "entered",
      sequence: 1,
      family: "context",
      attempt: null,
      sourceEventId: "compact-1",
      sourceEventType: "context_compaction_gate_blocked_tool",
      error: null,
      breakerOpen: false,
      model: null,
    });
    TURN_TRANSITION_TEST_ONLY.foldTransition(state, {
      reason: "compaction_gate_blocked",
      status: "entered",
      sequence: 2,
      family: "context",
      attempt: null,
      sourceEventId: "compact-2",
      sourceEventType: "context_compaction_gate_blocked_tool",
      error: null,
      breakerOpen: false,
      model: null,
    });
    TURN_TRANSITION_TEST_ONLY.foldTransition(state, {
      reason: "compaction_gate_blocked",
      status: "completed",
      sequence: 3,
      family: "context",
      attempt: null,
      sourceEventId: "compact-clear",
      sourceEventType: "context_compaction_gate_cleared",
      error: null,
      breakerOpen: false,
      model: null,
    });

    expect(state.activeTransitionKeys.size).toBe(0);
    expect(state.activeReasonCounts.compaction_gate_blocked).toBeUndefined();
    expect(state.pendingFamily).toBeNull();
  });

  test("maps pending parent-turn terminal delegation outcomes into persisted delegation transitions", () => {
    const cases = [
      {
        eventType: "subagent_completed",
        status: "completed",
      },
      {
        eventType: "subagent_failed",
        status: "failed",
      },
      {
        eventType: "subagent_cancelled",
        status: "cancelled",
      },
    ] as const;

    for (const testCase of cases) {
      const runtime = createRuntimeFixture();
      const sessionId = `turn-transition-pending-delegation-${testCase.status}`;
      const coordinator = getHostedTurnTransitionCoordinator(runtime);

      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        turn: 9,
        type: testCase.eventType,
        payload: {
          runId: `run-pending-${testCase.status}`,
          delegate: "review",
          status: testCase.status,
          summary: "Waiting for the parent turn to consume the delegation outcome.",
          deliveryMode: "text_only",
          deliveryHandoffState: "pending_parent_turn",
          deliveryReadyAt: 9,
          deliveryUpdatedAt: 9,
        },
      });

      expect(coordinator.getSnapshot(sessionId).pendingFamily).toBe("delegation");

      expect(() => {
        recordSessionTurnTransition(runtime, {
          sessionId,
          turn: 10,
          reason: "subagent_delivery_pending",
          status: "completed",
          family: "delegation",
        });
      }).not.toThrow();

      const transitions = runtime.inspect.events.records.queryStructured(sessionId, {
        type: "session_turn_transition",
      });
      expect(transitions).toHaveLength(2);
      expect(transitions[0]?.payload).toMatchObject({
        reason: "subagent_delivery_pending",
        status: "entered",
        family: "delegation",
        sourceEventType: testCase.eventType,
      });
      expect(transitions[1]?.payload).toMatchObject({
        reason: "subagent_delivery_pending",
        status: "completed",
        family: "delegation",
      });
    }
  });
});
