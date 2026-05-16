import type { BrewvaConfig } from "../../config/types.js";
import {
  estimateTokenCount,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
  truncateTextToTokenBudget,
} from "../../utils/token.js";
import type {
  ContextAdmissionDecision,
  ContextBudgetUsage,
  ContextCompactionDecision,
  ContextCompactionReason,
} from "./types.js";

interface SessionBudgetState {
  turnIndex: number;
  lastCompactionTurn: number;
  lastCompactionAtMs?: number;
  lastContextUsage?: ContextBudgetUsage;
  pendingCompactionReason?: ContextCompactionReason;
  autoCompactionConsecutiveFailures: number;
  autoCompactionBreakerOpen: boolean;
  deferredAutoCompactionReason?: string | null;
}

export interface EffectiveContextBudgetPolicy {
  dynamicTailTokens: number;
  compactionThresholdPercent: number;
  hardLimitPercent: number;
  effectiveContextWindow: number | null;
  autoCompactLimitTokens: number | null;
  controllableBaselineTokens: number;
}

export class ContextBudgetManager {
  private readonly config: BrewvaConfig["infrastructure"]["contextBudget"];
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionBudgetState>();

  constructor(
    config: BrewvaConfig["infrastructure"]["contextBudget"],
    options: { now?: () => number } = {},
  ) {
    this.config = config;
    this.now = options.now ?? Date.now;
  }

  beginTurn(sessionId: string, turnIndex: number): void {
    const state = this.getOrCreate(sessionId);
    state.turnIndex = Math.max(state.turnIndex, turnIndex);
  }

  observeUsage(sessionId: string, usage: ContextBudgetUsage | undefined): void {
    if (!usage) return;
    const state = this.getOrCreate(sessionId);
    state.lastContextUsage = {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: resolveContextUsageRatio(usage),
      maxOutputTokens: usage.maxOutputTokens,
    };
  }

  getEffectivePolicy(sessionId: string, usage?: ContextBudgetUsage): EffectiveContextBudgetPolicy {
    const current = this.resolveUsage(sessionId, usage);
    const contextWindow =
      typeof current?.contextWindow === "number" &&
      Number.isFinite(current.contextWindow) &&
      current.contextWindow > 0
        ? current.contextWindow
        : null;
    const effectiveHeadroom = this.resolveEffectiveHeadroom(
      contextWindow,
      this.config.thresholds.headroomTokens,
      current?.maxOutputTokens,
    );
    const configuredHardLimitPercent = normalizePercent(this.config.thresholds.hardRatio) ?? 1;
    const hardLimitPercent =
      contextWindow === null || contextWindow <= 0
        ? configuredHardLimitPercent
        : Math.min(
            configuredHardLimitPercent,
            Math.max(0, Math.min(1, 1 - effectiveHeadroom / contextWindow)),
          );
    const compactionThresholdPercent = Math.min(
      hardLimitPercent,
      normalizePercent(this.config.thresholds.advisoryRatio) ?? hardLimitPercent,
    );
    const dynamicTailTokens = Math.max(1, Math.trunc(this.config.dynamicTailTokens));

    return {
      dynamicTailTokens,
      compactionThresholdPercent,
      hardLimitPercent,
      effectiveContextWindow: contextWindow,
      autoCompactLimitTokens:
        contextWindow === null ? null : Math.floor(contextWindow * compactionThresholdPercent),
      controllableBaselineTokens: 0,
    };
  }

  getEffectiveDynamicTailTokenBudget(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).dynamicTailTokens;
  }

  getEffectiveCompactionThresholdPercent(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).compactionThresholdPercent;
  }

  getEffectiveHardLimitPercent(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).hardLimitPercent;
  }

  getEffectiveContextWindow(sessionId: string, usage?: ContextBudgetUsage): number | null {
    return this.getEffectivePolicy(sessionId, usage).effectiveContextWindow;
  }

  getControllableBaselineTokens(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).controllableBaselineTokens;
  }

  getPredictiveTurnGrowthTokens(contextWindow: number): number {
    return contextWindow > 0 ? Math.max(0, Math.trunc(this.config.predictedTurnGrowthTokens)) : 0;
  }

  planDynamicTailAdmission(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
  ): ContextAdmissionDecision {
    if (!this.config.enabled) {
      const tokens = estimateTokenCount(inputText);
      return {
        accepted: true,
        finalText: inputText,
        originalTokens: tokens,
        finalTokens: tokens,
        truncated: false,
      };
    }

    this.observeUsage(sessionId, usage);
    const state = this.getOrCreate(sessionId);
    const currentUsage = usage ?? state.lastContextUsage;
    const usagePercent = resolveContextUsageRatio(currentUsage);
    const effectivePolicy = this.getEffectivePolicy(sessionId, currentUsage);
    const originalTokens = estimateTokenCount(inputText);

    if (usagePercent !== null && usagePercent >= effectivePolicy.hardLimitPercent) {
      return {
        accepted: false,
        finalText: "",
        originalTokens,
        finalTokens: 0,
        truncated: false,
        droppedReason: "hard_limit",
      };
    }

    let tokenBudget = effectivePolicy.dynamicTailTokens;
    const projectedTokenBudget = this.resolveProjectedDynamicTailTokenBudget(
      currentUsage,
      effectivePolicy.hardLimitPercent,
    );
    if (projectedTokenBudget !== null) {
      tokenBudget = Math.min(tokenBudget, projectedTokenBudget);
      if (tokenBudget <= 0) {
        return {
          accepted: false,
          finalText: "",
          originalTokens,
          finalTokens: 0,
          truncated: false,
          droppedReason: "hard_limit",
        };
      }
    }

    const finalText = truncateTextToTokenBudget(inputText, tokenBudget);
    const finalTokens = estimateTokenCount(finalText);
    return {
      accepted: finalText.length > 0,
      finalText,
      originalTokens,
      finalTokens,
      truncated: finalTokens < originalTokens,
    };
  }

  shouldRequestCompaction(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextCompactionDecision {
    if (!this.config.enabled) {
      return { shouldCompact: false };
    }

    this.observeUsage(sessionId, usage);
    const state = this.getOrCreate(sessionId);
    const current = usage ?? state.lastContextUsage;
    if (state.pendingCompactionReason) {
      return { shouldCompact: true, reason: state.pendingCompactionReason, usage: current };
    }
    if (!current) {
      return { shouldCompact: false };
    }
    const usagePercent = resolveContextUsageRatio(current);
    if (usagePercent === null) {
      return { shouldCompact: false, usage: current };
    }

    const effectivePolicy = this.getEffectivePolicy(sessionId, usage);
    const hardLimitPercent = effectivePolicy.hardLimitPercent;
    const compactionThresholdPercent = effectivePolicy.compactionThresholdPercent;
    const bypassCooldown = usagePercent >= hardLimitPercent;

    if (!bypassCooldown) {
      const sinceLastCompaction = Math.max(0, state.turnIndex - state.lastCompactionTurn);
      if (sinceLastCompaction < this.config.compaction.minTurnsBetween) {
        return { shouldCompact: false, usage: current };
      }
    }

    if (usagePercent >= hardLimitPercent) {
      return { shouldCompact: true, reason: "hard_limit", usage: current };
    }
    if (usagePercent >= compactionThresholdPercent) {
      return { shouldCompact: true, reason: "usage_threshold", usage: current };
    }
    const currentTokens = resolveContextUsageTokens(current);
    if (
      currentTokens !== null &&
      Number.isFinite(current?.contextWindow) &&
      current.contextWindow > 0
    ) {
      const hardLimitTokens = Math.floor(hardLimitPercent * current.contextWindow);
      const predictedTurnGrowthTokens = this.getPredictiveTurnGrowthTokens(current.contextWindow);
      if (currentTokens >= hardLimitTokens) {
        return { shouldCompact: true, reason: "hard_limit", usage: current };
      }
      if (
        predictedTurnGrowthTokens > 0 &&
        currentTokens + predictedTurnGrowthTokens >= hardLimitTokens
      ) {
        return { shouldCompact: true, reason: "predicted_overflow", usage: current };
      }
    }
    return { shouldCompact: false, usage: current };
  }

  markCompacted(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.lastCompactionTurn = state.turnIndex;
    state.lastCompactionAtMs = this.now();
    state.pendingCompactionReason = undefined;
  }

  requestCompaction(sessionId: string, reason: ContextCompactionReason): void {
    const state = this.getOrCreate(sessionId);
    state.pendingCompactionReason = reason;
  }

  getPendingCompactionReason(sessionId: string): ContextCompactionReason | null {
    const state = this.sessions.get(sessionId);
    if (!state?.pendingCompactionReason) return null;
    return state.pendingCompactionReason;
  }

  getAutoCompactionPolicyState(sessionId: string): {
    consecutiveFailures: number;
    breakerOpen: boolean;
    deferredReason: string | null;
  } {
    const state = this.getOrCreate(sessionId);
    return {
      consecutiveFailures: state.autoCompactionConsecutiveFailures,
      breakerOpen: state.autoCompactionBreakerOpen,
      deferredReason: state.deferredAutoCompactionReason ?? null,
    };
  }

  rememberDeferredAutoCompactionReason(sessionId: string, reason: string | null): boolean {
    const state = this.getOrCreate(sessionId);
    const previous = state.deferredAutoCompactionReason ?? null;
    state.deferredAutoCompactionReason = reason;
    return previous !== reason;
  }

  recordAutoCompactionFailure(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.autoCompactionConsecutiveFailures += 1;
    state.deferredAutoCompactionReason = null;
    if (state.autoCompactionConsecutiveFailures >= 3) {
      state.autoCompactionBreakerOpen = true;
    }
  }

  recordAutoCompactionSuccess(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.autoCompactionConsecutiveFailures = 0;
    state.autoCompactionBreakerOpen = false;
    state.deferredAutoCompactionReason = null;
  }

  restoreAutoCompactionPolicyFromEvents(
    sessionId: string,
    events: readonly { type: string }[],
  ): void {
    const state = this.getOrCreate(sessionId);
    state.autoCompactionConsecutiveFailures = 0;
    state.autoCompactionBreakerOpen = false;
    state.deferredAutoCompactionReason = null;
    for (const event of events) {
      if (event.type === "context_compaction_auto_failed") {
        state.autoCompactionConsecutiveFailures += 1;
        if (state.autoCompactionConsecutiveFailures >= 3) {
          state.autoCompactionBreakerOpen = true;
        }
        continue;
      }
      if (event.type === "context_compaction_auto_completed" || event.type === "session_compact") {
        state.autoCompactionConsecutiveFailures = 0;
        state.autoCompactionBreakerOpen = false;
        state.deferredAutoCompactionReason = null;
      }
    }
  }

  getLastContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    const state = this.sessions.get(sessionId);
    if (!state?.lastContextUsage) return undefined;
    return {
      tokens: state.lastContextUsage.tokens,
      contextWindow: state.lastContextUsage.contextWindow,
      percent: state.lastContextUsage.percent,
      maxOutputTokens: state.lastContextUsage.maxOutputTokens,
    };
  }

  getLastCompactionTurn(sessionId: string): number | null {
    const state = this.sessions.get(sessionId);
    if (!state || !Number.isFinite(state.lastCompactionTurn)) return null;
    return Math.floor(state.lastCompactionTurn);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  getCompactionInstructions(): string {
    return this.config.compactionInstructions;
  }

  private resolveEffectiveHeadroom(
    contextWindow: number | null,
    configHeadroomTokens: number,
    maxOutputTokens: number | null | undefined,
  ): number {
    const configured = Math.max(0, Math.trunc(configHeadroomTokens));
    if (
      typeof maxOutputTokens === "number" &&
      Number.isFinite(maxOutputTokens) &&
      maxOutputTokens > 0
    ) {
      return Math.max(configured, Math.trunc(maxOutputTokens));
    }
    return configured;
  }

  private resolveUsage(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextBudgetUsage | undefined {
    return usage ?? this.getOrCreate(sessionId).lastContextUsage;
  }

  private resolveProjectedDynamicTailTokenBudget(
    usage: ContextBudgetUsage | undefined,
    hardLimitPercent: number,
  ): number | null {
    if (!usage) return null;
    if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
      return null;
    }

    const currentTokens = resolveContextUsageTokens(usage);
    if (currentTokens === null) {
      return null;
    }

    const hardLimitBoundaryTokens =
      // Keep projected usage strictly below the hard limit boundary after injection.
      Math.ceil(Math.max(0, Math.min(1, hardLimitPercent)) * usage.contextWindow) - 1;
    return Math.max(0, hardLimitBoundaryTokens - currentTokens);
  }

  private getOrCreate(sessionId: string): SessionBudgetState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionBudgetState = {
      turnIndex: 0,
      lastCompactionTurn: -Number.MAX_SAFE_INTEGER,
      lastCompactionAtMs: undefined,
      lastContextUsage: undefined,
      autoCompactionConsecutiveFailures: 0,
      autoCompactionBreakerOpen: false,
      deferredAutoCompactionReason: null,
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}
