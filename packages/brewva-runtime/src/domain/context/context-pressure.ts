import type { BrewvaConfig } from "../../config/types.js";
import { resolveContextUsageRatio } from "../../utils/token.js";
import type { ContextBudgetManager } from "./budget.js";
import type { ContextBudgetUsage, ContextCompactionGateStatus, ContextStatus } from "./types.js";

export type PredictiveTurnGrowthPolicy =
  BrewvaConfig["infrastructure"]["contextBudget"]["predictiveTurnGrowth"];

export function estimatePredictiveTurnGrowthTokens(
  contextWindow: number,
  policy: PredictiveTurnGrowthPolicy,
): number {
  const normalizedWindow = Math.max(0, Math.trunc(contextWindow));
  if (normalizedWindow <= 0) {
    return 0;
  }
  const floorContextWindow = Math.max(1, Math.trunc(policy.floorContextWindow));
  const largeContextWindow = Math.max(floorContextWindow, Math.trunc(policy.largeContextWindow));
  const standardTokens = Math.max(1, Math.trunc(policy.standardTokens));
  const largeTokens = Math.max(1, Math.trunc(policy.largeTokens));
  const scalingFactor = Math.max(0, Math.min(1, policy.scalingFactor));

  if (normalizedWindow < floorContextWindow) {
    return 0;
  }
  if (normalizedWindow >= largeContextWindow) {
    return largeTokens;
  }
  const scaledGrowth = Math.floor(normalizedWindow * scalingFactor);
  return Math.max(1, Math.min(standardTokens, Math.max(standardTokens, scaledGrowth)));
}

export function getContextUsage(
  contextBudget: ContextBudgetManager,
  sessionId: string,
): ContextBudgetUsage | undefined {
  const usage = contextBudget.getLastContextUsage(sessionId);
  if (!usage) return undefined;
  return {
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
  };
}

export function getContextUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
  return resolveContextUsageRatio(usage);
}

export function getContextHardLimitRatio(
  contextBudget: ContextBudgetManager,
  sessionId: string,
  usage?: ContextBudgetUsage,
): number {
  return Math.max(0, Math.min(1, contextBudget.getEffectiveHardLimitPercent(sessionId, usage)));
}

export function getContextCompactionThresholdRatio(
  contextBudget: ContextBudgetManager,
  sessionId: string,
  usage?: ContextBudgetUsage,
): number {
  return Math.max(
    0,
    Math.min(1, contextBudget.getEffectiveCompactionThresholdPercent(sessionId, usage)),
  );
}

export function getContextStatus(input: {
  contextBudget: ContextBudgetManager;
  sessionId: string;
  usage?: ContextBudgetUsage;
}): ContextStatus {
  const effectiveUsage = input.usage ?? getContextUsage(input.contextBudget, input.sessionId);
  const contextWindow = Math.max(0, Math.trunc(effectiveUsage?.contextWindow ?? 0));
  const tokens =
    typeof effectiveUsage?.tokens === "number" && Number.isFinite(effectiveUsage.tokens)
      ? Math.max(0, Math.trunc(effectiveUsage.tokens))
      : null;
  const usageRatio = getContextUsageRatio(effectiveUsage);
  const hardLimitRatio = getContextHardLimitRatio(
    input.contextBudget,
    input.sessionId,
    effectiveUsage,
  );
  const compactionThresholdRatio = getContextCompactionThresholdRatio(
    input.contextBudget,
    input.sessionId,
    effectiveUsage,
  );
  const hardLimitTokens = Math.floor(hardLimitRatio * contextWindow);
  const predictedTurnGrowthTokens =
    input.contextBudget.getPredictiveTurnGrowthTokens(contextWindow);
  const tokensUntilPredictedOverflow =
    tokens === null ? null : Math.max(0, hardLimitTokens - predictedTurnGrowthTokens - tokens);
  const predictedOverflow =
    tokens !== null && predictedTurnGrowthTokens > 0
      ? tokens + predictedTurnGrowthTokens >= hardLimitTokens
      : false;

  return {
    tokensUsed: tokens,
    tokensTotal: contextWindow,
    tokensRemaining: tokens === null ? null : Math.max(0, contextWindow - tokens),
    tokensUntilForcedCompact: tokens === null ? null : Math.max(0, hardLimitTokens - tokens),
    predictedTurnGrowthTokens,
    tokensUntilPredictedOverflow,
    predictedOverflow,
    usageRatio,
    hardLimitRatio,
    compactionThresholdRatio,
    compactionAdvised: usageRatio !== null && usageRatio >= compactionThresholdRatio,
    forcedCompaction: usageRatio !== null && usageRatio >= hardLimitRatio,
  };
}

export function getRecentCompactionWindowTurns(config: BrewvaConfig): number {
  return Math.max(1, config.infrastructure.contextBudget.compaction.minTurnsBetween);
}

export function getContextCompactionGateStatus(input: {
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  sessionId: string;
  usage?: ContextBudgetUsage;
  getCurrentTurn: (sessionId: string) => number;
}): ContextCompactionGateStatus {
  const status = getContextStatus({
    contextBudget: input.contextBudget,
    sessionId: input.sessionId,
    usage: input.usage,
  });
  const windowTurns = getRecentCompactionWindowTurns(input.config);
  const lastCompactionTurn = input.contextBudget.getLastCompactionTurn(input.sessionId);
  const turnsSinceCompaction =
    lastCompactionTurn === null
      ? null
      : Math.max(0, input.getCurrentTurn(input.sessionId) - lastCompactionTurn);
  const recentCompaction =
    turnsSinceCompaction !== null && Number.isFinite(turnsSinceCompaction)
      ? turnsSinceCompaction < windowTurns
      : false;
  const pendingReason = input.contextBudget.getPendingCompactionReason(input.sessionId);
  const required =
    input.config.infrastructure.contextBudget.enabled &&
    status.forcedCompaction &&
    !recentCompaction;

  return {
    required,
    reason: required ? (pendingReason ?? "hard_limit") : null,
    status,
    recentCompaction,
    windowTurns,
    lastCompactionTurn,
    turnsSinceCompaction,
  };
}
