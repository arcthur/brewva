import type { BrewvaConfig, SessionCostSummary } from "../types.js";
import {
  applyCostUpdatePayload,
  buildCostSummary,
  getCostBudgetStatus,
  getCostSkillTotalTokens,
  type CostAlert,
  type CostFoldState,
  type CostUsageContext,
  type CostUsageInput,
  cloneCostSkillLastTurnByName,
  createEmptyCostFoldState,
  recordCostToolCall,
  recordCostUsage,
  restoreCostFoldStateFromSummary,
} from "./fold.js";

export type ModelUsageInput = CostUsageInput;

export interface BudgetStatus {
  action: "warn" | "block_tools";
  sessionExceeded: boolean;
  blocked: boolean;
  reason?: string;
}

export interface RecordUsageResult {
  summary: SessionCostSummary;
  newAlerts: CostAlert[];
}

export class SessionCostTracker {
  private readonly config: BrewvaConfig["infrastructure"]["costTracking"];
  private readonly sessions = new Map<string, CostFoldState>();

  constructor(config: BrewvaConfig["infrastructure"]["costTracking"]) {
    this.config = config;
  }

  recordToolCall(sessionId: string, input: { toolName: string; turn: number }): void {
    recordCostToolCall(this.getOrCreate(sessionId), input, {
      incrementCallCount: true,
    });
  }

  restoreToolCallForTurn(sessionId: string, input: { toolName: string; turn: number }): void {
    recordCostToolCall(this.getOrCreate(sessionId), input, {
      incrementCallCount: false,
    });
  }

  recordUsage(
    sessionId: string,
    usage: ModelUsageInput,
    context: CostUsageContext,
  ): RecordUsageResult {
    const state = this.getOrCreate(sessionId);
    const newAlerts = recordCostUsage(state, usage, context, this.config);
    return {
      summary: buildCostSummary(state, { config: this.config }),
      newAlerts,
    };
  }

  getSummary(sessionId: string): SessionCostSummary {
    return buildCostSummary(this.getOrCreate(sessionId), { config: this.config });
  }

  getSkillTotalTokens(sessionId: string, skillName: string): number {
    return getCostSkillTotalTokens(this.getOrCreate(sessionId), skillName);
  }

  getBudgetStatus(sessionId: string): BudgetStatus {
    return getCostBudgetStatus(this.getOrCreate(sessionId), this.config);
  }

  getSkillLastTurnByName(sessionId: string): Record<string, number> {
    return cloneCostSkillLastTurnByName(this.getOrCreate(sessionId).skillLastTurnByName);
  }

  restore(
    sessionId: string,
    snapshot: SessionCostSummary | undefined,
    skillLastTurnByName?: Record<string, number>,
  ): void {
    if (!snapshot) return;

    const threshold = this.config.maxCostUsdPerSession * this.config.alertThresholdRatio;
    const state = restoreCostFoldStateFromSummary(snapshot, skillLastTurnByName, {
      sessionThresholdAlerted:
        snapshot.alerts.some((alert) => alert.kind === "session_threshold") ||
        (threshold > 0 && snapshot.totalCostUsd >= threshold),
      sessionCapAlerted:
        snapshot.alerts.some((alert) => alert.kind === "session_cap") ||
        (this.config.maxCostUsdPerSession > 0 &&
          snapshot.totalCostUsd >= this.config.maxCostUsdPerSession),
    });
    state.budget = getCostBudgetStatus(state, this.config);
    this.sessions.set(sessionId, state);
  }

  applyCostUpdateEvent(
    sessionId: string,
    payload: Record<string, unknown> | null,
    turn: number,
    timestamp: number,
  ): void {
    if (!payload) return;
    applyCostUpdatePayload(this.getOrCreate(sessionId), payload, timestamp, turn);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getOrCreate(sessionId: string): CostFoldState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created = createEmptyCostFoldState(this.config.actionOnExceed);
    this.sessions.set(sessionId, created);
    return created;
  }
}
