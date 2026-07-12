import {
  decideCompaction,
  resolveCompactionPressureReason,
  type CompactionPolicyDecision,
} from "@brewva/brewva-substrate/context-budget";
import type {
  ContextCompactionGateStatus,
  ContextCompactionReason,
} from "@brewva/brewva-vocabulary/context";

export const DEFAULT_COMPACTION_NUDGE_FULL_EVERY_TURNS = 5;
export type ContextLifecyclePressureAction =
  | "none"
  | "workbench_compact_soon"
  | "workbench_compact_now";

export type ContextLifecycleNudgeKind = "none" | "gate" | "advisory";
export type ContextLifecycleNudgeMode = "full" | "brief" | null;

interface CompactionNudgeState {
  key: string;
  firstTurn: number;
  lastTurn: number;
  renderCount: number;
}

export interface ContextLifecyclePressureDecision {
  readonly action: ContextLifecyclePressureAction;
  readonly reason: ContextCompactionReason | null;
}

export interface ContextLifecycleNudgeDecision {
  readonly kind: ContextLifecycleNudgeKind;
  readonly mode: ContextLifecycleNudgeMode;
}

export interface ContextNudgeCadenceInput {
  readonly sessionId: string;
  readonly turn: number;
  readonly pressure: ContextLifecyclePressureDecision;
  readonly enabled?: boolean;
}

export interface ContextNudgeCadenceTracker {
  decide(input: ContextNudgeCadenceInput): ContextLifecycleNudgeDecision;
  clearSession(sessionId: string): void;
  reset(): void;
}

export interface ContextTransientReductionDecision {
  readonly allowed: boolean;
  readonly detail: string | null;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
  readonly cacheCold: boolean;
}

export interface ContextAutoCompactionEligibilityInput {
  readonly gateStatus: ContextCompactionGateStatus;
  readonly pendingCompactionReason?: ContextCompactionReason | null;
  readonly hasUI?: boolean;
  readonly allowNonInteractive?: boolean;
  readonly idle?: boolean;
  readonly recoveryPosture?: "idle" | "active";
  readonly autoCompactionInFlight?: boolean;
  readonly autoCompactionBreakerOpen?: boolean;
  readonly autoCompactionIneffective?: boolean;
}

export interface ContextTransientReductionEligibilityInput {
  readonly contextBudgetEnabled: boolean;
  readonly usageAvailable: boolean;
  readonly usageSource?: "runtime" | "provider_payload";
  readonly postureBlockReason: string | null;
  readonly gateStatus?: ContextCompactionGateStatus | null;
  readonly pendingCompactionReason?: string | null;
  readonly compactionEligibilityDecision?: string;
  readonly compactionEligibilityReason?: string;
  readonly cacheCold: boolean;
}

export function resolveContextPressureReason(
  gateStatus: ContextCompactionGateStatus,
  pendingReason?: ContextCompactionReason | null,
): ContextCompactionReason | null {
  return resolveCompactionPressureReason(gateStatus, pendingReason);
}

export function decideContextPressure(input: {
  readonly gateStatus?: ContextCompactionGateStatus | null;
  readonly pendingCompactionReason?: ContextCompactionReason | null;
}): ContextLifecyclePressureDecision {
  const reason = input.gateStatus
    ? resolveContextPressureReason(input.gateStatus, input.pendingCompactionReason)
    : (input.pendingCompactionReason ?? null);
  if (!reason) {
    return { action: "none", reason: null };
  }
  if (
    input.gateStatus?.required ||
    reason === "hard_limit" ||
    input.gateStatus?.status.forcedCompaction
  ) {
    return { action: "workbench_compact_now", reason };
  }
  return { action: "workbench_compact_soon", reason };
}

function resolveNudgeKind(pressure: ContextLifecyclePressureDecision): ContextLifecycleNudgeKind {
  if (pressure.action === "workbench_compact_now") return "gate";
  if (pressure.action === "workbench_compact_soon") return "advisory";
  return "none";
}

export function createContextNudgeCadenceTracker(
  options: {
    readonly fullEveryTurns?: number;
  } = {},
): ContextNudgeCadenceTracker {
  const stateBySession = new Map<string, CompactionNudgeState>();
  const fullEveryTurns =
    typeof options.fullEveryTurns === "number" && Number.isFinite(options.fullEveryTurns)
      ? Math.max(1, Math.trunc(options.fullEveryTurns))
      : DEFAULT_COMPACTION_NUDGE_FULL_EVERY_TURNS;

  return {
    decide(input) {
      return decideContextNudgeWithState(input, stateBySession, fullEveryTurns);
    },
    clearSession(sessionId) {
      stateBySession.delete(sessionId);
    },
    reset() {
      stateBySession.clear();
    },
  };
}

function decideContextNudgeWithState(
  input: ContextNudgeCadenceInput,
  stateBySession: Map<string, CompactionNudgeState>,
  fullEveryTurns: number,
): ContextLifecycleNudgeDecision {
  const kind = resolveNudgeKind(input.pressure);
  if (kind === "none" || input.enabled === false) {
    if (kind === "none") {
      stateBySession.delete(input.sessionId);
    }
    return { kind, mode: null };
  }

  const key =
    kind === "gate" ? "gate:required" : `advisory:${input.pressure.reason ?? "unknown_pressure"}`;
  const previous = stateBySession.get(input.sessionId);
  const next =
    previous?.key === key
      ? {
          ...previous,
          lastTurn: input.turn,
          renderCount: previous.renderCount + 1,
        }
      : {
          key,
          firstTurn: input.turn,
          lastTurn: input.turn,
          renderCount: 1,
        };
  stateBySession.set(input.sessionId, next);

  return {
    kind,
    mode:
      next.renderCount === 1 || (next.renderCount - 1) % fullEveryTurns === 0 ? "full" : "brief",
  };
}

export function decideTransientReductionEligibility(
  input: ContextTransientReductionEligibilityInput,
): ContextTransientReductionDecision {
  if (!input.contextBudgetEnabled) {
    return {
      allowed: false,
      detail: "context budget is disabled",
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  if (!input.usageAvailable) {
    return {
      allowed: false,
      detail: "context usage is unavailable",
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const compactionAdvised = input.gateStatus?.status.compactionAdvised ?? false;
  const forcedCompaction = input.gateStatus?.status.forcedCompaction ?? false;
  const providerPayloadPressure = input.usageSource === "provider_payload";

  if (
    (input.gateStatus?.required || input.gateStatus?.reason === "hard_limit" || forcedCompaction) &&
    !providerPayloadPressure
  ) {
    return {
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  if (input.pendingCompactionReason === "hard_limit" && !providerPayloadPressure) {
    return {
      allowed: false,
      detail: "hard-limit compaction is already pending",
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  if (providerPayloadPressure && (forcedCompaction || compactionAdvised)) {
    return {
      allowed: true,
      detail: null,
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  // Recovery/degraded/approval posture blocks the discretionary reduction paths
  // below (advisory compaction, cache-cold). It is deliberately checked *after*
  // the provider-payload pressure allow above: when the outbound payload itself
  // is the pressure source it must be reduced to fit regardless of posture, but
  // otherwise the payload stays byte-faithful while the session is mid-recovery.
  if (input.postureBlockReason) {
    return {
      allowed: false,
      detail: input.postureBlockReason,
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  if (
    input.compactionEligibilityDecision === "skip" &&
    input.compactionEligibilityReason === "recent_compaction"
  ) {
    return {
      allowed: false,
      detail: "recent compaction cooldown is active",
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  if (
    (input.compactionEligibilityDecision === "execute" ||
      input.compactionEligibilityDecision === "advisory_only") &&
    compactionAdvised
  ) {
    return {
      allowed: true,
      detail: null,
      compactionAdvised,
      forcedCompaction,
      cacheCold: input.cacheCold,
    };
  }

  if (input.cacheCold) {
    return {
      allowed: true,
      detail: null,
      compactionAdvised,
      forcedCompaction,
      cacheCold: true,
    };
  }

  return {
    allowed: false,
    detail: "context status is below the transient reduction threshold",
    compactionAdvised,
    forcedCompaction,
    cacheCold: input.cacheCold,
  };
}

export function decideAutoCompactionEligibility(
  input: ContextAutoCompactionEligibilityInput,
): CompactionPolicyDecision {
  return decideCompaction({
    caller: "auto",
    gateStatus: input.gateStatus,
    pendingReason: input.pendingCompactionReason,
    hasUI: input.hasUI,
    allowNonInteractive: input.allowNonInteractive,
    idle: input.idle,
    recoveryPosture: input.recoveryPosture,
    autoCompactionInFlight: input.autoCompactionInFlight,
    autoCompactionBreakerOpen: input.autoCompactionBreakerOpen,
    autoCompactionIneffective: input.autoCompactionIneffective,
  });
}
