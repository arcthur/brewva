import { ContextArena } from "./arena.js";
import type { ZoneBudgetConfig } from "./zone-budget.js";

export type ContextInjectionPriority = "critical" | "high" | "normal" | "low";
export type ContextInjectionTruncationStrategy = "drop-entry" | "summarize" | "tail";

export interface RegisterContextInjectionInput {
  source: string;
  id: string;
  content: string;
  priority?: ContextInjectionPriority;
  estimatedTokens?: number;
  oncePerSession?: boolean;
}

export interface ContextInjectionEntry {
  source: string;
  id: string;
  content: string;
  priority: ContextInjectionPriority;
  estimatedTokens: number;
  timestamp: number;
  oncePerSession: boolean;
  truncated: boolean;
}

export interface ContextInjectionConsumeResult {
  text: string;
  entries: ContextInjectionEntry[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface ContextInjectionPlanResult extends ContextInjectionConsumeResult {
  consumedKeys: string[];
  planReason?: "floor_unmet";
}

export class ContextInjectionCollector {
  private readonly arena: ContextArena;

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      truncationStrategy?: ContextInjectionTruncationStrategy;
      zoneBudgets?: ZoneBudgetConfig;
    } = {},
  ) {
    this.arena = new ContextArena({
      sourceTokenLimits: options.sourceTokenLimits,
      truncationStrategy: options.truncationStrategy,
      zoneLayout: true,
      zoneBudgets: options.zoneBudgets,
    });
  }

  register(sessionId: string, input: RegisterContextInjectionInput): void {
    this.arena.append(sessionId, input);
  }

  plan(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult {
    return this.arena.plan(sessionId, totalTokenBudget);
  }

  commit(sessionId: string, consumedKeys: string[]): void {
    this.arena.markPresented(sessionId, consumedKeys);
  }

  consume(sessionId: string, totalTokenBudget: number): ContextInjectionConsumeResult {
    const plan = this.plan(sessionId, totalTokenBudget);
    this.commit(sessionId, plan.consumedKeys);
    return {
      text: plan.text,
      entries: plan.entries,
      estimatedTokens: plan.estimatedTokens,
      truncated: plan.truncated,
    };
  }

  clearPending(sessionId: string): void {
    this.arena.clearPending(sessionId);
  }

  onCompaction(sessionId: string): void {
    this.arena.resetEpoch(sessionId);
  }

  clearSession(sessionId: string): void {
    this.arena.clearSession(sessionId);
  }
}
