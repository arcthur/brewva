import type {
  ContextBudgetUsage,
  ContextCompactionDecision,
  ContextCompactionReason,
  ContextInjectionDecision,
  BrewvaConfig,
} from "../types.js";
import {
  estimateTokenCount,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
  truncateTextToTokenBudget,
} from "../utils/token.js";

interface SessionBudgetState {
  turnIndex: number;
  lastCompactionTurn: number;
  lastCompactionAtMs?: number;
  lastContextUsage?: ContextBudgetUsage;
  pendingCompactionReason?: ContextCompactionReason;
}

export interface EffectiveContextBudgetPolicy {
  injectionTokens: number;
  compactionThresholdPercent: number;
  hardLimitPercent: number;
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
    const hardLimitPercent = this.resolveAdaptiveThreshold({
      contextWindow,
      floorPercent: this.config.thresholds.hardLimitFloorPercent,
      ceilingPercent: this.config.thresholds.hardLimitCeilingPercent,
      headroomTokens: this.config.thresholds.hardLimitHeadroomTokens,
    });
    const compactionThresholdPercent = Math.min(
      hardLimitPercent,
      this.resolveAdaptiveThreshold({
        contextWindow,
        floorPercent: this.config.thresholds.compactionFloorPercent,
        ceilingPercent: this.config.thresholds.compactionCeilingPercent,
        headroomTokens: this.config.thresholds.compactionHeadroomTokens,
      }),
    );

    const baseInjectionTokens = Math.max(1, Math.floor(this.config.injection.baseTokens));
    const adaptiveInjectionTokens =
      contextWindow === null ? 0 : Math.floor(contextWindow * this.config.injection.windowFraction);
    const injectionTokens = Math.max(
      1,
      Math.min(
        Math.max(baseInjectionTokens, Math.floor(this.config.injection.maxTokens)),
        baseInjectionTokens + adaptiveInjectionTokens,
      ),
    );

    return {
      injectionTokens,
      compactionThresholdPercent,
      hardLimitPercent,
    };
  }

  getEffectiveInjectionTokenBudget(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).injectionTokens;
  }

  getEffectiveCompactionThresholdPercent(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).compactionThresholdPercent;
  }

  getEffectiveHardLimitPercent(sessionId: string, usage?: ContextBudgetUsage): number {
    return this.getEffectivePolicy(sessionId, usage).hardLimitPercent;
  }

  planInjection(
    sessionId: string,
    inputText: string,
    usage?: ContextBudgetUsage,
  ): ContextInjectionDecision {
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

    let tokenBudget = effectivePolicy.injectionTokens;
    const projectedTokenBudget = this.resolveProjectedInjectionTokenBudget(
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
    const usagePercent = resolveContextUsageRatio(current);
    if (state.pendingCompactionReason) {
      return { shouldCompact: true, reason: state.pendingCompactionReason, usage: current };
    }
    if (usagePercent === null) {
      return { shouldCompact: false, usage: current };
    }

    const effectivePolicy = this.getEffectivePolicy(sessionId, usage);
    const hardLimitPercent = effectivePolicy.hardLimitPercent;
    const compactionThresholdPercent = effectivePolicy.compactionThresholdPercent;
    const pressureBypassPercent = normalizePercent(this.config.compaction.pressureBypassPercent);
    // This stays static on purpose. A fixed bypass line lets large-window models skip cooldown
    // earlier than the adaptive hard limit would, which is desirable once pressure is already high.
    const bypassCooldown =
      usagePercent >= hardLimitPercent ||
      (pressureBypassPercent !== null && usagePercent >= pressureBypassPercent);

    if (!bypassCooldown) {
      const sinceLastCompaction = Math.max(0, state.turnIndex - state.lastCompactionTurn);
      if (sinceLastCompaction < this.config.compaction.minTurnsBetween) {
        return { shouldCompact: false, usage: current };
      }

      const minSecondsBetweenCompaction = this.config.compaction.minSecondsBetween;
      const minCooldownMs = Math.floor(minSecondsBetweenCompaction * 1000);
      if (minCooldownMs > 0 && typeof state.lastCompactionAtMs === "number") {
        const elapsedMs = Math.max(0, this.now() - state.lastCompactionAtMs);
        if (elapsedMs < minCooldownMs) {
          return { shouldCompact: false, usage: current };
        }
      }
    }

    if (usagePercent >= hardLimitPercent) {
      return { shouldCompact: true, reason: "hard_limit", usage: current };
    }
    if (usagePercent >= compactionThresholdPercent) {
      return { shouldCompact: true, reason: "usage_threshold", usage: current };
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

  getLastContextUsage(sessionId: string): ContextBudgetUsage | undefined {
    const state = this.sessions.get(sessionId);
    if (!state?.lastContextUsage) return undefined;
    return {
      tokens: state.lastContextUsage.tokens,
      contextWindow: state.lastContextUsage.contextWindow,
      percent: state.lastContextUsage.percent,
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

  private resolveUsage(
    sessionId: string,
    usage?: ContextBudgetUsage,
  ): ContextBudgetUsage | undefined {
    return usage ?? this.getOrCreate(sessionId).lastContextUsage;
  }

  private resolveAdaptiveThreshold(input: {
    contextWindow: number | null;
    floorPercent: number;
    ceilingPercent: number;
    headroomTokens: number;
  }): number {
    const floorPercent = normalizePercent(input.floorPercent) ?? 0;
    const ceilingPercent = Math.max(
      floorPercent,
      normalizePercent(input.ceilingPercent) ?? floorPercent,
    );
    if (input.contextWindow === null || input.contextWindow <= 0) {
      return floorPercent;
    }
    const byHeadroom = Math.max(0, Math.min(1, 1 - input.headroomTokens / input.contextWindow));
    return Math.max(floorPercent, Math.min(ceilingPercent, byHeadroom));
  }

  private resolveProjectedInjectionTokenBudget(
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
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}
