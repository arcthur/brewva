import {
  RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
} from "../../events/registry.js";
import { REASONING_REVERT_EVENT_TYPE } from "../reasoning/api.js";
import { SESSION_HYDRATION_COST_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_HYDRATION_LEDGER_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_HYDRATION_RESOURCE_LEASE_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_HYDRATION_SKILL_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_HYDRATION_TOOL_LIFECYCLE_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_HYDRATION_VERIFICATION_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { SESSION_INTEGRITY_TURN_LIFECYCLE_PLACEMENT } from "../sessions/api.js";
import { TASK_WATCHDOG_TURN_LIFECYCLE_PLACEMENT } from "../task/api.js";

export type TurnLifecycleGate =
  | "ingress_received"
  | "admission_resolved"
  | "effect_authorized"
  | "execution_recorded"
  | "recovery_settled"
  | "terminal_recorded";

export type TurnLifecycleFoldId =
  | "session_hydration_cost"
  | "session_hydration_ledger"
  | "session_hydration_resource_lease"
  | "session_hydration_skill"
  | "session_hydration_tool_lifecycle"
  | "session_hydration_verification"
  | "session_integrity"
  | "task_watchdog";

export type TurnLifecycleRecoveryReason =
  | "compaction_retry"
  | "max_output_recovery"
  | "provider_fallback_retry"
  | "reasoning_revert_resume"
  | "rollback_receipt"
  | "session_shutdown"
  | "wal_recovery_resume";

export interface TurnLifecycleSnapshot {
  sessionId: string;
  turnId: string;
  gate: TurnLifecycleGate;
  superseded: boolean;
  supersedeReason?: string;
}

export interface TurnLifecycleIdentity {
  sessionId: string;
  turnId: string;
}

export interface TurnLifecycleAdvanceInput extends TurnLifecycleIdentity {
  gate: TurnLifecycleGate;
}

export interface TurnLifecycleRecoverySupersedeInput extends TurnLifecycleAdvanceInput {
  reason: TurnLifecycleRecoveryReason;
}

export interface TurnLifecycleFoldPlacement {
  readonly foldId: TurnLifecycleFoldId;
  readonly source: string;
  readonly observes: readonly TurnLifecycleGate[];
  readonly role: "hydrate" | "integrity" | "watchdog";
}

export interface TurnLifecycleRecoveryPlacement {
  readonly reason: TurnLifecycleRecoveryReason;
  readonly trustedGate: TurnLifecycleGate;
  readonly resumeGate: TurnLifecycleGate;
  readonly supersedeGate: TurnLifecycleGate;
  readonly receiptEventTypes: readonly string[];
}

const GATE_RANK: Record<TurnLifecycleGate, number> = {
  ingress_received: 0,
  admission_resolved: 1,
  effect_authorized: 2,
  execution_recorded: 3,
  recovery_settled: 4,
  terminal_recorded: 5,
};

export const TURN_LIFECYCLE_FOLD_PLACEMENTS = [
  SESSION_HYDRATION_COST_TURN_LIFECYCLE_PLACEMENT,
  SESSION_HYDRATION_LEDGER_TURN_LIFECYCLE_PLACEMENT,
  SESSION_HYDRATION_RESOURCE_LEASE_TURN_LIFECYCLE_PLACEMENT,
  SESSION_HYDRATION_SKILL_TURN_LIFECYCLE_PLACEMENT,
  SESSION_HYDRATION_TOOL_LIFECYCLE_TURN_LIFECYCLE_PLACEMENT,
  SESSION_HYDRATION_VERIFICATION_TURN_LIFECYCLE_PLACEMENT,
  SESSION_INTEGRITY_TURN_LIFECYCLE_PLACEMENT,
  TASK_WATCHDOG_TURN_LIFECYCLE_PLACEMENT,
] as const satisfies readonly TurnLifecycleFoldPlacement[];

export const TURN_LIFECYCLE_RECOVERY_PLACEMENTS = [
  {
    reason: "wal_recovery_resume",
    trustedGate: "ingress_received",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [
      SESSION_TURN_TRANSITION_EVENT_TYPE,
      RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
    ],
  },
  {
    reason: "reasoning_revert_resume",
    trustedGate: "execution_recorded",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [SESSION_TURN_TRANSITION_EVENT_TYPE, REASONING_REVERT_EVENT_TYPE],
  },
  {
    reason: "compaction_retry",
    trustedGate: "admission_resolved",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [SESSION_TURN_TRANSITION_EVENT_TYPE, SESSION_COMPACT_EVENT_TYPE],
  },
  {
    reason: "provider_fallback_retry",
    trustedGate: "admission_resolved",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [SESSION_TURN_TRANSITION_EVENT_TYPE],
  },
  {
    reason: "max_output_recovery",
    trustedGate: "admission_resolved",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [SESSION_TURN_TRANSITION_EVENT_TYPE],
  },
  {
    reason: "rollback_receipt",
    trustedGate: "execution_recorded",
    resumeGate: "recovery_settled",
    supersedeGate: "recovery_settled",
    receiptEventTypes: [
      ROLLBACK_EVENT_TYPE,
      REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
      SESSION_REWIND_COMPLETED_EVENT_TYPE,
    ],
  },
  {
    reason: "session_shutdown",
    trustedGate: "ingress_received",
    resumeGate: "terminal_recorded",
    supersedeGate: "terminal_recorded",
    receiptEventTypes: [SESSION_SHUTDOWN_EVENT_TYPE],
  },
] as const satisfies readonly TurnLifecycleRecoveryPlacement[];

export function compareTurnLifecycleGates(
  left: TurnLifecycleGate,
  right: TurnLifecycleGate,
): number {
  return GATE_RANK[left] - GATE_RANK[right];
}

export function getTurnLifecycleFoldPlacements(): readonly TurnLifecycleFoldPlacement[] {
  return TURN_LIFECYCLE_FOLD_PLACEMENTS;
}

export function getTurnLifecycleRecoveryPlacements(): readonly TurnLifecycleRecoveryPlacement[] {
  return TURN_LIFECYCLE_RECOVERY_PLACEMENTS;
}

export function getTurnLifecycleRecoveryPlacement(
  reason: string,
): TurnLifecycleRecoveryPlacement | undefined {
  return TURN_LIFECYCLE_RECOVERY_PLACEMENTS.find((placement) => placement.reason === reason);
}

function stateKey(input: TurnLifecycleIdentity): string {
  return `${input.sessionId}\u0000${input.turnId}`;
}

function cloneSnapshot(snapshot: TurnLifecycleSnapshot): TurnLifecycleSnapshot {
  return { ...snapshot };
}

function assertMonotonicGateTransition(input: {
  snapshot: TurnLifecycleSnapshot;
  nextGate: TurnLifecycleGate;
  operation: "advance" | "supersede";
}): void {
  const currentRank = GATE_RANK[input.snapshot.gate];
  const nextRank = GATE_RANK[input.nextGate];
  if (nextRank < currentRank) {
    throw new Error(
      `turn_spine_non_monotonic_${input.operation}:${input.snapshot.sessionId}:${input.snapshot.turnId}:${input.snapshot.gate}->${input.nextGate}`,
    );
  }
}

export class TurnLifecycleSpine {
  private readonly turns = new Map<string, TurnLifecycleSnapshot>();

  startTurn(input: TurnLifecycleIdentity): TurnLifecycleSnapshot {
    const key = stateKey(input);
    const existing = this.turns.get(key);
    if (existing) {
      return cloneSnapshot(existing);
    }
    const snapshot: TurnLifecycleSnapshot = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      gate: "ingress_received",
      superseded: false,
    };
    this.turns.set(key, snapshot);
    return cloneSnapshot(snapshot);
  }

  advance(input: TurnLifecycleAdvanceInput): TurnLifecycleSnapshot {
    const snapshot = this.requireTurn(input);
    assertMonotonicGateTransition({
      snapshot,
      nextGate: input.gate,
      operation: "advance",
    });
    const currentRank = GATE_RANK[snapshot.gate];
    const nextRank = GATE_RANK[input.gate];
    if (nextRank === currentRank) {
      return cloneSnapshot(snapshot);
    }
    snapshot.gate = input.gate;
    return cloneSnapshot(snapshot);
  }

  supersedeForRecovery(input: TurnLifecycleRecoverySupersedeInput): TurnLifecycleSnapshot {
    const snapshot = this.requireTurn(input);
    assertMonotonicGateTransition({
      snapshot,
      nextGate: input.gate,
      operation: "supersede",
    });
    snapshot.gate = input.gate;
    snapshot.superseded = true;
    snapshot.supersedeReason = input.reason;
    return cloneSnapshot(snapshot);
  }

  get(input: TurnLifecycleIdentity): TurnLifecycleSnapshot | undefined {
    const snapshot = this.turns.get(stateKey(input));
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  clearSession(sessionId: string): void {
    for (const [key, snapshot] of this.turns) {
      if (snapshot.sessionId === sessionId) {
        this.turns.delete(key);
      }
    }
  }

  private requireTurn(input: TurnLifecycleIdentity): TurnLifecycleSnapshot {
    const snapshot = this.turns.get(stateKey(input));
    if (!snapshot) {
      throw new Error(`turn_spine_missing_turn:${input.sessionId}:${input.turnId}`);
    }
    return snapshot;
  }
}
