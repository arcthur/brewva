import type { ContextCompactionReason, ContextStatus } from "./types.js";

export type ContextCompactionGateMode = "hosted_auto" | "tool_gate" | "transient_reduction";

export type ContextCompactionEligibilitySkipReason =
  | "no_request"
  | "recent_compaction"
  | "non_interactive_mode"
  | "agent_active_manual_compaction_unsafe"
  | "auto_compaction_breaker_open"
  | "auto_compaction_in_flight"
  | "recovery_active";

export interface ContextCompactionEligibilityInput {
  readonly enabled: boolean;
  readonly status: ContextStatus;
  readonly pendingReason: ContextCompactionReason | null;
  readonly recentCompaction: boolean;
  readonly hasUI: boolean;
  readonly idle: boolean;
  readonly recoveryPosture: "idle" | "active";
  readonly autoCompactionInFlight: boolean;
  readonly autoCompactionBreakerOpen: boolean;
  readonly gateMode: ContextCompactionGateMode;
}

export type ContextCompactionEligibility =
  | {
      readonly decision: "execute";
      readonly reason: ContextCompactionReason;
    }
  | {
      readonly decision: "advisory_only";
      readonly reason: ContextCompactionReason;
    }
  | {
      readonly decision: "skip";
      readonly reason: ContextCompactionEligibilitySkipReason;
    }
  | {
      readonly decision: "gate_blocked";
      readonly reason: "hard_limit";
    };

function resolvePressureReason(
  input: ContextCompactionEligibilityInput,
): ContextCompactionReason | null {
  if (input.pendingReason) {
    return input.pendingReason;
  }
  if (input.status.forcedCompaction) {
    return "hard_limit";
  }
  if (input.status.predictedOverflow) {
    return "predicted_overflow";
  }
  if (input.status.compactionAdvised) {
    return "usage_threshold";
  }
  return null;
}

export function resolveContextCompactionEligibility(
  input: ContextCompactionEligibilityInput,
): ContextCompactionEligibility {
  if (!input.enabled) {
    return { decision: "skip", reason: "no_request" };
  }

  const reason = resolvePressureReason(input);
  if (!reason) {
    return { decision: "skip", reason: "no_request" };
  }

  if (
    input.gateMode === "tool_gate" &&
    reason === "hard_limit" &&
    input.status.forcedCompaction &&
    !input.recentCompaction
  ) {
    return { decision: "gate_blocked", reason: "hard_limit" };
  }

  if (input.recentCompaction && reason !== "hard_limit") {
    return { decision: "skip", reason: "recent_compaction" };
  }

  if (input.recoveryPosture === "active") {
    return { decision: "skip", reason: "recovery_active" };
  }

  if (input.gateMode === "transient_reduction") {
    if (reason === "hard_limit") {
      return { decision: "skip", reason: "no_request" };
    }
    return { decision: "advisory_only", reason };
  }

  if (!input.hasUI) {
    return { decision: "skip", reason: "non_interactive_mode" };
  }
  if (!input.idle) {
    return { decision: "skip", reason: "agent_active_manual_compaction_unsafe" };
  }
  if (input.autoCompactionBreakerOpen) {
    return { decision: "skip", reason: "auto_compaction_breaker_open" };
  }
  if (input.autoCompactionInFlight) {
    return { decision: "skip", reason: "auto_compaction_in_flight" };
  }
  return { decision: "execute", reason };
}
