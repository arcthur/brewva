import type { BrewvaConfig } from "../../config/types.js";
import { resolveContextUsageRatio } from "../../utils/token.js";
import type { ContextBudgetManager } from "./budget.js";
import type { ContextBudgetUsage, ContextCompactionGateStatus, ContextStatus } from "./types.js";

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
    maxOutputTokens: usage.maxOutputTokens,
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
  const policy = input.contextBudget.getEffectivePolicy(input.sessionId, effectiveUsage);
  const effectiveTokensTotal = policy.effectiveContextWindow ?? contextWindow;
  const autoCompactLimitTokens =
    policy.autoCompactLimitTokens ?? Math.floor(compactionThresholdRatio * contextWindow);
  const controllableBaselineTokens = Math.min(
    effectiveTokensTotal,
    Math.max(0, Math.trunc(policy.controllableBaselineTokens)),
  );
  const controllableTokensTotal = Math.max(0, effectiveTokensTotal - controllableBaselineTokens);
  const controllableTokensUsed =
    tokens === null ? null : Math.max(0, tokens - controllableBaselineTokens);
  const controllableTokensRemaining =
    controllableTokensUsed === null
      ? null
      : Math.max(0, controllableTokensTotal - controllableTokensUsed);
  const controllableContextRemainingRatio =
    controllableTokensRemaining === null || controllableTokensTotal <= 0
      ? null
      : controllableTokensRemaining / controllableTokensTotal;
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
    effectiveTokensTotal,
    tokensRemaining: tokens === null ? null : Math.max(0, contextWindow - tokens),
    autoCompactLimitTokens,
    controllableBaselineTokens,
    controllableTokensUsed,
    controllableTokensTotal,
    controllableTokensRemaining,
    controllableContextRemainingRatio,
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
