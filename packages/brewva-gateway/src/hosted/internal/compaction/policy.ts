import type {
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";

export type CompactionPolicyCaller = "manual" | "auto" | "model_downshift";

export type CompactionPolicySkipReason =
  | "no_request"
  | "recent_compaction"
  | "non_interactive_mode"
  | "agent_active_manual_compaction_unsafe"
  | "auto_compaction_in_flight"
  | "recovery_active"
  | "target_context_not_smaller"
  | "usage_unknown";

export interface CompactionPolicyInputs {
  caller: CompactionPolicyCaller;
  gateStatus: ContextCompactionGateStatus;
  pendingReason?: ContextCompactionReason | null;
  hasUI?: boolean;
  idle?: boolean;
  recoveryPosture?: "idle" | "active";
  autoCompactionInFlight?: boolean;
  currentContextWindow?: number;
  targetContextWindow?: number;
  usageKnown?: boolean;
}

export type CompactionPolicyDecision =
  | {
      decision: "execute";
      caller: CompactionPolicyCaller;
      reason: ContextCompactionReason;
    }
  | {
      decision: "skip";
      caller: CompactionPolicyCaller;
      reason: CompactionPolicySkipReason;
    };

function pressureReason(
  status: ContextStatus,
  pendingReason?: ContextCompactionReason | null,
): ContextCompactionReason | null {
  if (pendingReason) return pendingReason;
  if (status.forcedCompaction) return "hard_limit";
  if (status.predictedOverflow) return "predicted_overflow";
  if (status.compactionAdvised) return "usage_threshold";
  return null;
}

export function decideCompaction(input: CompactionPolicyInputs): CompactionPolicyDecision {
  if (input.caller === "manual") {
    return { decision: "execute", caller: input.caller, reason: "manual" };
  }

  if (input.caller === "model_downshift") {
    if (
      typeof input.currentContextWindow === "number" &&
      typeof input.targetContextWindow === "number" &&
      (input.currentContextWindow <= 0 ||
        input.targetContextWindow <= 0 ||
        input.targetContextWindow >= input.currentContextWindow)
    ) {
      return { decision: "skip", caller: input.caller, reason: "target_context_not_smaller" };
    }
    if (input.usageKnown === false) {
      return { decision: "skip", caller: input.caller, reason: "usage_unknown" };
    }
    const reason = pressureReason(input.gateStatus.status, input.pendingReason);
    if (!reason) {
      return { decision: "skip", caller: input.caller, reason: "no_request" };
    }
    if (input.gateStatus.recentCompaction && reason !== "hard_limit") {
      return { decision: "skip", caller: input.caller, reason: "recent_compaction" };
    }
    return { decision: "execute", caller: input.caller, reason };
  }

  const reason = pressureReason(input.gateStatus.status, input.pendingReason);
  if (!reason) {
    return { decision: "skip", caller: input.caller, reason: "no_request" };
  }
  if (input.gateStatus.recentCompaction && reason !== "hard_limit") {
    return { decision: "skip", caller: input.caller, reason: "recent_compaction" };
  }
  if (input.recoveryPosture === "active") {
    return { decision: "skip", caller: input.caller, reason: "recovery_active" };
  }
  if (input.hasUI === false) {
    return { decision: "skip", caller: input.caller, reason: "non_interactive_mode" };
  }
  if (input.idle === false) {
    return {
      decision: "skip",
      caller: input.caller,
      reason: "agent_active_manual_compaction_unsafe",
    };
  }
  if (input.autoCompactionInFlight === true) {
    return { decision: "skip", caller: input.caller, reason: "auto_compaction_in_flight" };
  }
  return { decision: "execute", caller: input.caller, reason };
}
