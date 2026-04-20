import { describe, expect, test } from "bun:test";
import { resolveNextThreadLoopDecision } from "../../../packages/brewva-gateway/src/session/thread-loop-decision-resolver.js";
import { resolveThreadLoopProfile } from "../../../packages/brewva-gateway/src/session/thread-loop-profiles.js";
import { createInitialThreadLoopState } from "../../../packages/brewva-gateway/src/session/thread-loop-types.js";
import type { HostedTransitionSnapshot } from "../../../packages/brewva-gateway/src/session/turn-transition.js";

function snapshot(overrides: Partial<HostedTransitionSnapshot> = {}): HostedTransitionSnapshot {
  return {
    sequence: 0,
    latest: null,
    pendingFamily: null,
    activeAttemptSequence: null,
    activeReasonCounts: {},
    operatorVisibleFactGeneration: 0,
    consecutiveFailuresByReason: {},
    breakerOpenByReason: {},
    ...overrides,
  };
}

describe("thread loop decision resolver", () => {
  test("suspends explicitly when effect commitment approval is pending", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-approval",
      turnId: "turn-approval",
      runtimeTurn: 3,
      profile: resolveThreadLoopProfile({ source: "gateway" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "before_attempt",
      transitionSnapshot: snapshot({
        sequence: 1,
        latest: {
          reason: "effect_commitment_pending",
          status: "entered",
          sequence: 1,
          family: "approval",
          attempt: null,
          sourceEventId: "approval-event-1",
          sourceEventType: "effect_commitment_approval_requested",
          error: null,
          breakerOpen: false,
          model: null,
        },
        pendingFamily: "approval",
        activeReasonCounts: {
          effect_commitment_pending: 1,
        },
      }),
    });

    expect(decision).toMatchObject({
      action: "suspend_for_approval",
      reason: "effect_commitment_pending",
      sourceEventId: "approval-event-1",
    });
  });

  test("does not try provider fallback for the subagent profile", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-subagent",
      turnId: "turn-subagent",
      runtimeTurn: 1,
      profile: resolveThreadLoopProfile({ source: "subagent" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_failure",
      failure: new Error("provider returned error: 503"),
      compaction: {
        requestedGeneration: 0,
        completedGeneration: 0,
      },
      transitionSnapshot: snapshot(),
    });

    expect(decision).not.toMatchObject({
      action: "retry_with_policy",
      policy: "provider_fallback_retry",
    });
  });

  test("surfaces breaker-open as a terminal decision", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-breaker",
      turnId: "turn-breaker",
      runtimeTurn: 1,
      profile: resolveThreadLoopProfile({ source: "gateway" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_failure",
      failure: new Error("provider returned error: 503"),
      compaction: {
        requestedGeneration: 0,
        completedGeneration: 0,
      },
      transitionSnapshot: snapshot({
        breakerOpenByReason: {
          provider_fallback_retry: true,
        },
      }),
    });

    expect(decision).toMatchObject({
      action: "breaker_open",
      reason: "provider_fallback_retry",
    });
  });

  test("requests compact resume when a compaction generation interrupts an empty successful attempt", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-compact",
      turnId: "turn-compact",
      runtimeTurn: 1,
      profile: resolveThreadLoopProfile({ source: "channel" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_success",
      output: {
        attemptId: "attempt-1",
        assistantText: "",
      },
      compaction: {
        requestedGeneration: 1,
        completedGeneration: 1,
      },
      transitionSnapshot: snapshot(),
    });

    expect(decision).toMatchObject({
      action: "compact_resume_stream",
      afterGeneration: 1,
    });
  });

  test("requests compaction settlement from the resolver when a failed attempt advanced generation", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-compact-failure",
      turnId: "turn-compact-failure",
      runtimeTurn: 1,
      profile: resolveThreadLoopProfile({ source: "channel" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_failure",
      failure: new Error("context was compacted during prompt"),
      compaction: {
        requestedGeneration: 1,
        completedGeneration: 1,
      },
      transitionSnapshot: snapshot(),
    });

    expect(decision).toEqual({
      action: "wait_for_compaction_settlement",
      afterGeneration: 0,
    });
  });

  test("returns revert_then_stream when a pending reasoning revert resume is available", () => {
    const state = createInitialThreadLoopState({
      sessionId: "session-revert",
      turnId: "turn-revert",
      runtimeTurn: 1,
      profile: resolveThreadLoopProfile({ source: "channel" }),
      continuationCause: "initial",
      operatorVisibleCheckpoint: 0,
    });

    const decision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_failure",
      failure: new Error("turn aborted for reasoning revert"),
      compaction: {
        requestedGeneration: 0,
        completedGeneration: 0,
      },
      pendingReasoningResume: {
        prompt: "resume from restored branch",
        sourceEventId: "revert-event-1",
      },
      transitionSnapshot: snapshot(),
    });

    expect(decision).toEqual({
      action: "revert_then_stream",
      prompt: "resume from restored branch",
      sourceEventId: "revert-event-1",
    });
  });
});
