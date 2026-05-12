import {
  classifyRecoveryError,
  looksLikeMaxOutputError,
  looksLikeRetryableProviderError,
} from "./error-classification.js";
import { COMPACTION_RESUME_PROMPT } from "./recovery/prompts.js";
import type { RecoveryDecision as SessionRecoveryDecision, RecoveryEvidence } from "./state.js";
import type {
  ThreadLoopCompactionState,
  ThreadLoopDecision,
  ThreadLoopRecoveryPolicyName,
  ThreadLoopState,
} from "./state.js";
import type { HostedTransitionSnapshot } from "./turn-transition.js";

interface AttemptOutputSignal {
  readonly attemptId: string;
  readonly assistantText: string;
}

export type ThreadLoopDecisionSignal =
  | {
      readonly kind: "before_attempt";
      readonly transitionSnapshot: HostedTransitionSnapshot;
    }
  | {
      readonly kind: "after_attempt_failure";
      readonly failure: unknown;
      readonly compaction: Pick<
        ThreadLoopCompactionState,
        "requestedGeneration" | "completedGeneration"
      >;
      readonly pendingReasoningResume?: {
        readonly prompt: string;
        readonly sourceEventId: string;
      };
      readonly transitionSnapshot: HostedTransitionSnapshot;
    }
  | {
      readonly kind: "after_attempt_success";
      readonly output: AttemptOutputSignal;
      readonly compaction: Pick<
        ThreadLoopCompactionState,
        "requestedGeneration" | "completedGeneration"
      >;
      readonly transitionSnapshot: HostedTransitionSnapshot;
    };

function activeReasonCount(
  snapshot: HostedTransitionSnapshot,
  reason: keyof HostedTransitionSnapshot["activeReasonCounts"],
): number {
  return snapshot.activeReasonCounts[reason] ?? 0;
}

function createRecoveryEvidence(input: {
  state: ThreadLoopState;
  signal: Extract<ThreadLoopDecisionSignal, { kind: "after_attempt_failure" }>;
  source: string;
}): RecoveryEvidence {
  return {
    sessionId: input.state.sessionId,
    turnId: input.state.turnId,
    source: input.source,
    detail:
      input.signal.failure instanceof Error
        ? input.signal.failure.message
        : String(input.signal.failure),
  };
}

function resolveFailureRecoveryDecision(
  state: ThreadLoopState,
  signal: Extract<ThreadLoopDecisionSignal, { kind: "after_attempt_failure" }>,
): {
  decision: Extract<SessionRecoveryDecision, { kind: "continue" | "compact" }> | null;
  policy: ThreadLoopRecoveryPolicyName | null;
} {
  if (!state.profile.allowsPromptRecovery) {
    return { decision: null, policy: null };
  }
  const hasAttempted = (policy: ThreadLoopRecoveryPolicyName): boolean =>
    state.recoveryHistory.some((entry) => entry.policy === policy);
  const cause = classifyRecoveryError(signal.failure);
  if (looksLikeMaxOutputError(signal.failure)) {
    if (!hasAttempted("output_budget_escalation")) {
      return {
        decision: {
          kind: "continue",
          cause,
          evidence: createRecoveryEvidence({
            state,
            signal,
            source: "thread_loop:output_budget_escalation",
          }),
        },
        policy: "output_budget_escalation",
      };
    }
    if (!hasAttempted("max_output_recovery")) {
      return {
        decision: {
          kind: "compact",
          cause,
          evidence: createRecoveryEvidence({
            state,
            signal,
            source: "thread_loop:max_output_recovery",
          }),
        },
        policy: "max_output_recovery",
      };
    }
    return { decision: null, policy: null };
  }
  if (
    state.profile.allowsProviderFallbackRecovery &&
    looksLikeRetryableProviderError(signal.failure) &&
    !hasAttempted("provider_fallback_retry")
  ) {
    return {
      decision: {
        kind: "continue",
        cause,
        evidence: createRecoveryEvidence({
          state,
          signal,
          source: "thread_loop:provider_fallback_retry",
        }),
      },
      policy: "provider_fallback_retry",
    };
  }
  return { decision: null, policy: null };
}

export function resolveNextThreadLoopDecision(
  state: ThreadLoopState,
  signal: ThreadLoopDecisionSignal,
): ThreadLoopDecision {
  if (activeReasonCount(signal.transitionSnapshot, "effect_commitment_pending") > 0) {
    return {
      action: "suspend_for_approval",
      reason: "effect_commitment_pending",
      sourceEventId:
        signal.transitionSnapshot.latest?.reason === "effect_commitment_pending"
          ? signal.transitionSnapshot.latest.sourceEventId
          : null,
    };
  }

  if (signal.kind === "after_attempt_success") {
    if (
      state.profile.allowsPromptRecovery &&
      state.compactAttempts === 0 &&
      signal.compaction.requestedGeneration > state.compaction.requestedGeneration &&
      signal.output.assistantText.trim().length === 0
    ) {
      return {
        action: "compact_resume_stream",
        prompt: COMPACTION_RESUME_PROMPT,
        afterGeneration: signal.compaction.requestedGeneration,
      };
    }
    return { action: "complete" };
  }

  if (signal.kind === "before_attempt") {
    return { action: "stream" };
  }

  if (
    state.profile.allowsPromptRecovery &&
    signal.compaction.requestedGeneration > state.compaction.requestedGeneration
  ) {
    const recovery: Extract<SessionRecoveryDecision, { kind: "compact" }> = {
      kind: "compact",
      cause: classifyRecoveryError(signal.failure),
      evidence: createRecoveryEvidence({
        state,
        signal,
        source: "thread_loop:wait_for_compaction_settlement",
      }),
    };
    return {
      action: "wait_for_compaction_settlement",
      afterGeneration: state.compaction.requestedGeneration,
      recovery,
    };
  }

  if (state.profile.allowsReasoningRevertResume && signal.pendingReasoningResume) {
    const recovery: Extract<SessionRecoveryDecision, { kind: "reasoning-revert" }> = {
      kind: "reasoning-revert",
      cause: classifyRecoveryError(signal.failure),
      evidence: createRecoveryEvidence({
        state,
        signal,
        source: "thread_loop:reasoning_revert_resume",
      }),
    };
    return {
      action: "revert_then_stream",
      prompt: signal.pendingReasoningResume.prompt,
      sourceEventId: signal.pendingReasoningResume.sourceEventId,
      recovery,
    };
  }

  if (signal.transitionSnapshot.breakerOpenByReason.provider_fallback_retry === true) {
    return {
      action: "breaker_open",
      reason: "provider_fallback_retry",
    };
  }
  if (signal.transitionSnapshot.breakerOpenByReason.max_output_recovery === true) {
    return {
      action: "breaker_open",
      reason: "max_output_recovery",
    };
  }
  if (signal.transitionSnapshot.breakerOpenByReason.compaction_retry === true) {
    return {
      action: "breaker_open",
      reason: "compaction_retry",
    };
  }

  const recoverySelection = resolveFailureRecoveryDecision(state, signal);
  if (recoverySelection.decision && recoverySelection.policy) {
    return {
      action: "retry_with_policy",
      policy: recoverySelection.policy,
      recovery: recoverySelection.decision,
    };
  }

  const recovery: Extract<SessionRecoveryDecision, { kind: "abort" }> = {
    kind: "abort",
    cause: classifyRecoveryError(signal.failure),
    evidence: createRecoveryEvidence({
      state,
      signal,
      source: "thread_loop:abort",
    }),
  };
  return {
    action: "fail",
    error: signal.failure,
    recovery,
  };
}
