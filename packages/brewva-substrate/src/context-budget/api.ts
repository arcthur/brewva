import {
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/context";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";

export interface ContextBudgetThresholdConfig {
  readonly hardRatio: number;
  readonly advisoryRatio: number;
  readonly headroomTokens: number;
}

export interface ContextBudgetCompactionConfig {
  readonly minTurnsBetween?: number | null;
}

export interface ContextBudgetDerivationConfig {
  readonly enabled?: boolean;
  readonly thresholds: ContextBudgetThresholdConfig;
  /** Absolute override; when null/absent the ratio below scales with the window. */
  readonly predictedTurnGrowthTokens?: number | null;
  readonly predictedTurnGrowthRatio?: number | null;
  readonly compaction?: ContextBudgetCompactionConfig | null;
}

export interface ContextBudgetPredictionInput {
  readonly predictedTurnGrowthTokens?: number | null;
}

export interface ContextBudgetProviderPredictionInput {
  readonly predictedTurnGrowthTokensEma?: number | null;
}

export interface ContextBudgetRecentCompactionInput {
  readonly currentTurn?: number | null;
  readonly lastCompactionTurn?: number | null;
  readonly minTurnsBetween?: number | null;
}

export interface ContextBudgetStateInput {
  readonly usage?: ContextBudgetUsage | null;
  readonly config: ContextBudgetDerivationConfig;
  readonly model?: ContextBudgetPredictionInput | null;
  readonly provider?: ContextBudgetProviderPredictionInput | null;
  readonly request?: ContextBudgetPredictionInput | null;
  readonly recentCompaction?: ContextBudgetRecentCompactionInput | null;
  readonly targetContextWindow?: number | null;
}

export interface ContextBudgetLimits {
  readonly contextWindow: number;
  readonly hardLimitTokens: number;
  readonly advisoryLimitTokens: number;
  readonly hardLimitRatio: number;
  readonly advisoryLimitRatio: number;
}

export interface ContextBudgetState {
  readonly usage?: ContextBudgetUsage;
  readonly status: ContextStatus;
  readonly gateStatus: ContextCompactionGateStatus;
  readonly pendingReason: ContextCompactionReason | null;
  readonly recentCompaction: {
    readonly recent: boolean;
    readonly windowTurns: number | null;
    readonly lastCompactionTurn: number | null;
    readonly turnsSinceCompaction: number | null;
  };
  readonly effectivePredictedGrowthTokens: number;
  readonly limits: ContextBudgetLimits;
  readonly pressureRank: number;
}

export type CompactionPolicyCaller = "manual" | "auto" | "model_downshift";

export const AUTO_COMPACTION_BREAKER_THRESHOLD = 3;

export interface AutoCompactionBreakerEvent {
  readonly type: string;
  readonly timestamp?: unknown;
  readonly id?: unknown;
}

export type CompactionPolicySkipReason =
  | "no_request"
  | "recent_compaction"
  | "non_interactive_mode"
  | "agent_active_manual_compaction_unsafe"
  | "auto_compaction_in_flight"
  | "auto_compaction_breaker_open"
  | "recovery_active"
  | "target_context_not_smaller"
  | "usage_unknown";

export interface CompactionPolicyInputs {
  readonly caller: CompactionPolicyCaller;
  readonly gateStatus: ContextCompactionGateStatus;
  readonly pendingReason?: ContextCompactionReason | null;
  readonly hasUI?: boolean;
  readonly idle?: boolean;
  readonly recoveryPosture?: "idle" | "active";
  readonly autoCompactionInFlight?: boolean;
  readonly autoCompactionBreakerOpen?: boolean;
  readonly currentContextWindow?: number;
  readonly targetContextWindow?: number;
  readonly usageKnown?: boolean;
}

export type CompactionPolicyDecision =
  | {
      readonly decision: "execute";
      readonly caller: CompactionPolicyCaller;
      readonly reason: ContextCompactionReason;
    }
  | {
      readonly decision: "skip";
      readonly caller: CompactionPolicyCaller;
      readonly reason: CompactionPolicySkipReason;
    };

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readEventTimestamp(event: AutoCompactionBreakerEvent): number {
  return typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
    ? event.timestamp
    : 0;
}

function readEventId(event: AutoCompactionBreakerEvent): string {
  return typeof event.id === "string" ? event.id : "";
}

export function readAutoCompactionBreakerOpen(
  events: readonly AutoCompactionBreakerEvent[],
  threshold: number = AUTO_COMPACTION_BREAKER_THRESHOLD,
): boolean {
  const normalizedThreshold =
    typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
      ? Math.trunc(threshold)
      : AUTO_COMPACTION_BREAKER_THRESHOLD;
  const ordered = events.toSorted(
    (left, right) =>
      readEventTimestamp(right) - readEventTimestamp(left) ||
      readEventId(right).localeCompare(readEventId(left)),
  );
  let consecutiveFailures = 0;
  for (const event of ordered) {
    if (event.type === CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE) {
      return false;
    }
    if (event.type === CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= normalizedThreshold) {
        return true;
      }
    }
  }
  return false;
}

function clampUnitRatio(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function deriveContextWindow(input: ContextBudgetStateInput): number {
  return (
    positiveFinite(input.targetContextWindow) ?? positiveFinite(input.usage?.contextWindow) ?? 0
  );
}

function deriveLimitTokens(contextWindow: number, ratio: number, headroomTokens: number): number {
  if (contextWindow <= 0) return 0;
  const ratioLimit = Math.floor(contextWindow * clampUnitRatio(ratio));
  const headroomLimit = Math.max(0, contextWindow - Math.max(0, Math.floor(headroomTokens)));
  return Math.max(0, Math.min(ratioLimit, headroomLimit));
}

function deriveAdvisoryLimitTokens(
  contextWindow: number,
  advisoryRatio: number,
  hardLimitTokens: number,
): number {
  if (contextWindow <= 0) return 0;
  return Math.max(
    0,
    Math.min(Math.floor(contextWindow * clampUnitRatio(advisoryRatio)), hardLimitTokens),
  );
}

/**
 * Resolves a window-scaled token budget: an absolute token override wins;
 * otherwise the ratio scales with the context window so defaults stay
 * meaningful as model windows grow.
 */
export function resolveWindowScaledTokens(
  absoluteTokens: number | null | undefined,
  ratio: number | null | undefined,
  contextWindow: number | null | undefined,
): number | null {
  const absolute = finiteNonNegative(absoluteTokens);
  if (absolute !== null) {
    return Math.floor(absolute);
  }
  const window = positiveFinite(contextWindow);
  const unitRatio =
    typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, 1) : null;
  if (window === null || unitRatio === null) {
    return null;
  }
  return Math.floor(window * unitRatio);
}

function deriveEffectivePredictedGrowth(
  input: ContextBudgetStateInput,
  contextWindow: number,
): number {
  const candidates = [
    resolveWindowScaledTokens(
      input.config.predictedTurnGrowthTokens,
      input.config.predictedTurnGrowthRatio,
      contextWindow,
    ),
    input.model?.predictedTurnGrowthTokens,
    input.provider?.predictedTurnGrowthTokensEma,
    input.request?.predictedTurnGrowthTokens,
  ]
    .map(finiteNonNegative)
    .filter((value): value is number => value !== null);
  const raw = candidates.length === 0 ? 0 : Math.max(...candidates);
  return Math.min(Math.max(0, Math.floor(raw)), Math.max(0, Math.floor(contextWindow)));
}

function deriveRecentCompaction(
  input: ContextBudgetStateInput,
): ContextBudgetState["recentCompaction"] {
  const configuredWindow =
    finiteNonNegative(input.recentCompaction?.minTurnsBetween) ??
    finiteNonNegative(input.config.compaction?.minTurnsBetween) ??
    null;
  const windowTurns = configuredWindow === null ? null : Math.floor(configuredWindow);
  const lastCompactionTurn = finiteNonNegative(input.recentCompaction?.lastCompactionTurn);
  const currentTurn = finiteNonNegative(input.recentCompaction?.currentTurn);
  const turnsSinceCompaction =
    lastCompactionTurn === null || currentTurn === null
      ? null
      : Math.max(0, Math.floor(currentTurn - lastCompactionTurn));
  const recent =
    turnsSinceCompaction !== null &&
    windowTurns !== null &&
    windowTurns > 0 &&
    turnsSinceCompaction < windowTurns;

  return {
    recent,
    windowTurns,
    lastCompactionTurn,
    turnsSinceCompaction,
  };
}

function derivePressureRank(status: ContextStatus): number {
  if (status.forcedCompaction) return 3;
  if (status.predictedOverflow) return 2;
  if (status.compactionAdvised) return 1;
  return 0;
}

export function deriveContextBudgetState(input: ContextBudgetStateInput): ContextBudgetState {
  const contextWindow = deriveContextWindow(input);
  const budgetEnabled = input.config.enabled !== false;
  const hardLimitTokens = deriveLimitTokens(
    contextWindow,
    input.config.thresholds.hardRatio,
    input.config.thresholds.headroomTokens,
  );
  const advisoryLimitTokens = deriveAdvisoryLimitTokens(
    contextWindow,
    input.config.thresholds.advisoryRatio,
    hardLimitTokens,
  );
  const effectivePredictedGrowthTokens = budgetEnabled
    ? deriveEffectivePredictedGrowth(input, contextWindow)
    : 0;
  const usageTokens = finiteNonNegative(input.usage?.tokens);
  const pressureKnown = budgetEnabled && contextWindow > 0 && usageTokens !== null;
  const usageRatio =
    usageTokens === null || contextWindow <= 0 ? null : usageTokens / contextWindow;
  const tokensRemaining =
    usageTokens === null || contextWindow <= 0 ? null : Math.max(0, contextWindow - usageTokens);
  const tokensUntilForcedCompact =
    usageTokens === null ? null : Math.max(0, hardLimitTokens - usageTokens);
  const predictedOverflow =
    pressureKnown && usageTokens + effectivePredictedGrowthTokens >= hardLimitTokens;
  const tokensUntilPredictedOverflow =
    usageTokens === null
      ? null
      : Math.max(0, hardLimitTokens - usageTokens - effectivePredictedGrowthTokens);
  const compactionAdvised = pressureKnown && usageTokens >= advisoryLimitTokens;
  const forcedCompaction = pressureKnown && usageTokens >= hardLimitTokens;
  const hardLimitRatio =
    contextWindow <= 0
      ? clampUnitRatio(input.config.thresholds.hardRatio)
      : hardLimitTokens / contextWindow;
  const advisoryLimitRatio =
    contextWindow <= 0
      ? Math.min(clampUnitRatio(input.config.thresholds.advisoryRatio), hardLimitRatio)
      : advisoryLimitTokens / contextWindow;

  const status: ContextStatus = {
    tokensUsed: usageTokens,
    tokensTotal: contextWindow,
    effectiveTokensTotal: hardLimitTokens,
    tokensRemaining,
    tokensUntilForcedCompact,
    autoCompactLimitTokens: advisoryLimitTokens,
    controllableBaselineTokens: 0,
    controllableTokensUsed: usageTokens,
    controllableTokensTotal: hardLimitTokens,
    controllableTokensRemaining:
      usageTokens === null ? null : Math.max(0, hardLimitTokens - usageTokens),
    controllableContextRemainingRatio:
      usageTokens === null || hardLimitTokens <= 0
        ? null
        : Math.max(0, hardLimitTokens - usageTokens) / hardLimitTokens,
    predictedTurnGrowthTokens: effectivePredictedGrowthTokens,
    tokensUntilPredictedOverflow,
    predictedOverflow,
    usageRatio,
    hardLimitRatio,
    compactionThresholdRatio: advisoryLimitRatio,
    compactionAdvised,
    forcedCompaction,
  };

  const pendingReason = resolveCompactionPressureReason(
    {
      status,
      required: forcedCompaction,
      reason: forcedCompaction
        ? "hard_limit"
        : predictedOverflow
          ? "predicted_overflow"
          : compactionAdvised
            ? "usage_threshold"
            : null,
    },
    null,
  );
  const recentCompaction = deriveRecentCompaction(input);
  const gateStatus: ContextCompactionGateStatus = {
    status,
    required: forcedCompaction,
    reason: pendingReason,
    recentCompaction: recentCompaction.recent,
    windowTurns: recentCompaction.windowTurns,
    lastCompactionTurn: recentCompaction.lastCompactionTurn,
    turnsSinceCompaction: recentCompaction.turnsSinceCompaction,
  };

  return {
    usage: input.usage ?? undefined,
    status,
    gateStatus,
    pendingReason,
    recentCompaction,
    effectivePredictedGrowthTokens,
    limits: {
      contextWindow,
      hardLimitTokens,
      advisoryLimitTokens,
      hardLimitRatio,
      advisoryLimitRatio,
    },
    pressureRank: derivePressureRank(status),
  };
}

export function resolveCompactionPressureReason(
  gateStatus: ContextCompactionGateStatus,
  pendingReason?: ContextCompactionReason | null,
): ContextCompactionReason | null {
  if (pendingReason) return pendingReason;
  if (gateStatus.reason) return gateStatus.reason;
  const status = gateStatus.status;
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
    const reason = resolveCompactionPressureReason(input.gateStatus, input.pendingReason);
    if (!reason) {
      return { decision: "skip", caller: input.caller, reason: "no_request" };
    }
    if (input.gateStatus.recentCompaction && reason !== "hard_limit") {
      return { decision: "skip", caller: input.caller, reason: "recent_compaction" };
    }
    return { decision: "execute", caller: input.caller, reason };
  }

  const reason = resolveCompactionPressureReason(input.gateStatus, input.pendingReason);
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
  if (input.idle === false && reason !== "hard_limit") {
    // Below hard-limit pressure an active agent defers to advisory state.
    // Under hard_limit the host soft-cuts at the next complete tool-result
    // boundary instead of waiting for idle, so execution is safe.
    return {
      decision: "skip",
      caller: input.caller,
      reason: "agent_active_manual_compaction_unsafe",
    };
  }
  if (input.autoCompactionInFlight === true) {
    return { decision: "skip", caller: input.caller, reason: "auto_compaction_in_flight" };
  }
  if (input.autoCompactionBreakerOpen === true) {
    return { decision: "skip", caller: input.caller, reason: "auto_compaction_breaker_open" };
  }
  return { decision: "execute", caller: input.caller, reason };
}
