import { COMPACTION_RESUME_PROMPT } from "./compaction-recovery.js";
import {
  looksLikeMaxOutputError,
  looksLikeRetryableProviderError,
} from "./error-classification.js";
import type {
  ThreadLoopDecision,
  ThreadLoopCompactionState,
  ThreadLoopRecoveryPolicyName,
  ThreadLoopState,
} from "./thread-loop-types.js";
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

function resolveFailureRecoveryPolicy(
  state: ThreadLoopState,
  failure: unknown,
): ThreadLoopRecoveryPolicyName | null {
  if (!state.profile.allowsPromptRecovery) {
    return null;
  }
  const hasAttempted = (policy: ThreadLoopRecoveryPolicyName): boolean =>
    state.recoveryHistory.some((entry) => entry.policy === policy);
  if (looksLikeMaxOutputError(failure)) {
    if (!hasAttempted("output_budget_escalation")) {
      return "output_budget_escalation";
    }
    if (!hasAttempted("max_output_recovery")) {
      return "max_output_recovery";
    }
    return null;
  }
  if (
    state.profile.allowsProviderFallbackRecovery &&
    looksLikeRetryableProviderError(failure) &&
    !hasAttempted("provider_fallback_retry")
  ) {
    return "provider_fallback_retry";
  }
  return null;
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
    return {
      action: "wait_for_compaction_settlement",
      afterGeneration: state.compaction.requestedGeneration,
    };
  }

  if (state.profile.allowsReasoningRevertResume && signal.pendingReasoningResume) {
    return {
      action: "revert_then_stream",
      prompt: signal.pendingReasoningResume.prompt,
      sourceEventId: signal.pendingReasoningResume.sourceEventId,
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

  const policy = resolveFailureRecoveryPolicy(state, signal.failure);
  if (policy) {
    return {
      action: "retry_with_policy",
      policy,
    };
  }

  return {
    action: "fail",
    error: signal.failure,
  };
}
