import type { ToolOutputView } from "@brewva/brewva-runtime";
import type { SessionTurnTransitionReason as TurnTransitionReason } from "@brewva/brewva-runtime/events";
import type { HostedTransitionSnapshot } from "./turn-transition.js";

export type ThreadLoopProfileName =
  | "interactive"
  | "print"
  | "channel"
  | "scheduled"
  | "heartbeat"
  | "wal_recovery"
  | "subagent";

export type ThreadLoopContinuationCause =
  | "initial"
  | "tool_result"
  | "queue"
  | "follow_up"
  | "approval_resume"
  | "compaction_resume"
  | "reasoning_revert_resume"
  | "subagent_delivery";

export type ThreadLoopRecoveryPolicyName =
  | "deterministic_context_reduction"
  | "output_budget_escalation"
  | "provider_fallback_retry"
  | "max_output_recovery";

export interface ThreadLoopProfile {
  readonly name: ThreadLoopProfileName;
  readonly allowsScheduleTrigger: boolean;
  readonly allowsReasoningRevertResume: boolean;
  readonly allowsPromptRecovery: boolean;
  readonly allowsProviderFallbackRecovery: boolean;
  readonly allowsSubagentDelivery: boolean;
  readonly requiresRecoveryWalReplay: boolean;
  readonly settlesForegroundCompaction: boolean;
}

export interface ThreadLoopRecoveryHistoryEntry {
  readonly policy: ThreadLoopRecoveryPolicyName;
  readonly outcome: "recovered" | "continued" | "failed" | "aborted";
  readonly error?: string;
}

export interface ThreadLoopCompactionState {
  readonly requestedGeneration: number;
  readonly completedGeneration: number;
  readonly foregroundOwner: boolean;
}

export interface ThreadLoopState {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly runtimeTurn?: number;
  readonly profile: ThreadLoopProfile;
  readonly continuationCause: ThreadLoopContinuationCause;
  readonly attemptSequence: number;
  readonly compactAttempts: number;
  readonly recoveryHistory: readonly ThreadLoopRecoveryHistoryEntry[];
  readonly operatorVisibleCheckpoint: number;
  readonly compaction: ThreadLoopCompactionState;
  readonly lastDecision?: ThreadLoopDecision["action"];
}

export type ThreadLoopDecision =
  | { readonly action: "stream" }
  | {
      readonly action: "wait_for_compaction_settlement";
      readonly afterGeneration: number;
    }
  | {
      readonly action: "compact_resume_stream";
      readonly prompt: string;
      readonly afterGeneration: number;
    }
  | {
      readonly action: "revert_then_stream";
      readonly prompt: string;
      readonly sourceEventId: string;
    }
  | {
      readonly action: "retry_with_policy";
      readonly policy: ThreadLoopRecoveryPolicyName;
    }
  | {
      readonly action: "suspend_for_approval";
      readonly reason: Extract<TurnTransitionReason, "effect_commitment_pending">;
      readonly sourceEventId: string | null;
    }
  | {
      readonly action: "breaker_open";
      readonly reason: Extract<
        TurnTransitionReason,
        "compaction_retry" | "provider_fallback_retry" | "max_output_recovery"
      >;
    }
  | {
      readonly action: "fail";
      readonly error: unknown;
    }
  | { readonly action: "complete" };

export type ThreadLoopResult =
  | {
      readonly status: "completed";
      readonly attemptId: string;
      readonly assistantText: string;
      readonly toolOutputs: readonly ToolOutputView[];
      readonly diagnostic: ThreadLoopDiagnosticView;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly attemptId?: string;
      readonly assistantText?: string;
      readonly toolOutputs?: readonly ToolOutputView[];
      readonly diagnostic: ThreadLoopDiagnosticView;
    }
  | {
      readonly status: "suspended";
      readonly reason: "approval";
      readonly sourceEventId: string | null;
      readonly diagnostic: ThreadLoopDiagnosticView;
    }
  | {
      readonly status: "cancelled";
      readonly diagnostic: ThreadLoopDiagnosticView;
    };

export interface ThreadLoopDiagnosticView {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: ThreadLoopProfileName;
  readonly attemptSequence: number;
  readonly compactAttempts: number;
  readonly recoveryHistory: readonly ThreadLoopRecoveryHistoryEntry[];
  readonly compaction: ThreadLoopCompactionState;
  readonly transition?: HostedTransitionSnapshot;
  readonly lastDecision?: ThreadLoopDecision["action"];
}

function createInitialCompactionState(): ThreadLoopCompactionState {
  return {
    requestedGeneration: 0,
    completedGeneration: 0,
    foregroundOwner: false,
  };
}

export function createMinimalThreadLoopDiagnostic(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: ThreadLoopProfile | ThreadLoopProfileName;
  readonly attemptSequence?: number;
  readonly compactAttempts?: number;
  readonly recoveryHistory?: readonly ThreadLoopRecoveryHistoryEntry[];
  readonly compaction?: ThreadLoopCompactionState;
  readonly transition?: HostedTransitionSnapshot;
  readonly lastDecision?: ThreadLoopDecision["action"];
}): ThreadLoopDiagnosticView {
  const diagnostic: ThreadLoopDiagnosticView = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    profile: typeof input.profile === "string" ? input.profile : input.profile.name,
    attemptSequence: input.attemptSequence ?? 1,
    compactAttempts: input.compactAttempts ?? 0,
    recoveryHistory: input.recoveryHistory ?? [],
    compaction: input.compaction ?? createInitialCompactionState(),
  };

  return {
    ...diagnostic,
    ...(input.transition ? { transition: input.transition } : {}),
    ...(input.lastDecision ? { lastDecision: input.lastDecision } : {}),
  };
}

export function createInitialThreadLoopState(input: {
  sessionId: string;
  turnId?: string;
  runtimeTurn?: number;
  profile: ThreadLoopProfile;
  continuationCause: ThreadLoopContinuationCause;
  operatorVisibleCheckpoint: number;
}): ThreadLoopState {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeTurn: input.runtimeTurn,
    profile: input.profile,
    continuationCause: input.continuationCause,
    attemptSequence: 1,
    compactAttempts: 0,
    recoveryHistory: [],
    operatorVisibleCheckpoint: input.operatorVisibleCheckpoint,
    compaction: createInitialCompactionState(),
  };
}

export function projectThreadLoopDiagnostic(
  state: ThreadLoopState,
  transition?: HostedTransitionSnapshot,
): ThreadLoopDiagnosticView {
  return {
    sessionId: state.sessionId,
    turnId: state.turnId,
    profile: state.profile.name,
    attemptSequence: state.attemptSequence,
    compactAttempts: state.compactAttempts,
    recoveryHistory: state.recoveryHistory,
    compaction: state.compaction,
    transition,
    lastDecision: state.lastDecision,
  };
}
