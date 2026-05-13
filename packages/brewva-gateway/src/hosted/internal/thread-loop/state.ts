import type { SessionTurnTransitionReason as TurnTransitionReason } from "@brewva/brewva-runtime/events";
import type { ToolOutputView } from "@brewva/brewva-runtime/session";
import type { HostedTransitionSnapshot } from "./turn-transition.js";

export interface ClassifiedError {
  family: string;
  reason: string;
  detail?: string;
}

export interface RecoveryEvidence {
  sessionId?: string;
  turnId?: string;
  source: string;
  detail?: string;
}

export type RecoveryDecision =
  | { kind: "continue"; cause: ClassifiedError; evidence: RecoveryEvidence }
  | { kind: "compact"; cause: ClassifiedError; evidence: RecoveryEvidence }
  | { kind: "reasoning-revert"; cause: ClassifiedError; evidence: RecoveryEvidence }
  | { kind: "fork"; cause: ClassifiedError; evidence: RecoveryEvidence }
  | { kind: "abort"; cause: ClassifiedError; evidence: RecoveryEvidence };

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
      readonly recovery: Extract<RecoveryDecision, { kind: "compact" }>;
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
      readonly recovery: Extract<RecoveryDecision, { kind: "reasoning-revert" }>;
    }
  | {
      readonly action: "retry_with_policy";
      readonly policy: ThreadLoopRecoveryPolicyName;
      readonly recovery: Extract<RecoveryDecision, { kind: "continue" | "compact" }>;
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
      readonly recovery: Extract<RecoveryDecision, { kind: "abort" }>;
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

export interface ResolveThreadLoopProfileInput {
  readonly source?:
    | "interactive"
    | "print"
    | "gateway"
    | "heartbeat"
    | "schedule"
    | "channel"
    | "subagent";
  readonly triggerKind?: "schedule" | "heartbeat";
  readonly walReplayId?: string;
}

const PROFILE_BY_NAME: Record<ThreadLoopProfileName, ThreadLoopProfile> = {
  interactive: {
    name: "interactive",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
  print: {
    name: "print",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
  channel: {
    name: "channel",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
  scheduled: {
    name: "scheduled",
    allowsScheduleTrigger: true,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
  heartbeat: {
    name: "heartbeat",
    allowsScheduleTrigger: true,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
  wal_recovery: {
    name: "wal_recovery",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: true,
    settlesForegroundCompaction: true,
  },
  subagent: {
    name: "subagent",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: false,
    allowsSubagentDelivery: true,
    requiresRecoveryWalReplay: false,
    settlesForegroundCompaction: true,
  },
};

export function getThreadLoopProfile(name: ThreadLoopProfileName): ThreadLoopProfile {
  return PROFILE_BY_NAME[name];
}

export function resolveThreadLoopProfile(input: ResolveThreadLoopProfileInput): ThreadLoopProfile {
  if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
    return getThreadLoopProfile("wal_recovery");
  }
  if (input.triggerKind === "schedule" || input.source === "schedule") {
    return getThreadLoopProfile("scheduled");
  }
  if (input.triggerKind === "heartbeat" || input.source === "heartbeat") {
    return getThreadLoopProfile("heartbeat");
  }
  if (input.source === "interactive") {
    return getThreadLoopProfile("interactive");
  }
  if (input.source === "print") {
    return getThreadLoopProfile("print");
  }
  if (input.source === "channel") {
    return getThreadLoopProfile("channel");
  }
  if (input.source === "subagent") {
    return getThreadLoopProfile("subagent");
  }
  return getThreadLoopProfile("channel");
}
