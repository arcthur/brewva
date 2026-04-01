import { ContextArena } from "./arena.js";
import type { ContextInjectionBudgetClass, ContextInjectionCategory } from "./sources.js";

export interface RegisterContextInjectionInput {
  source: string;
  category: ContextInjectionCategory;
  budgetClass: ContextInjectionBudgetClass;
  id: string;
  content: string;
  estimatedTokens?: number;
  oncePerSession?: boolean;
}

export interface ContextInjectionEntry {
  source: string;
  category: ContextInjectionCategory;
  budgetClass: ContextInjectionBudgetClass;
  id: string;
  content: string;
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

export interface ContextInjectionPlanTelemetry {
  degradationApplied: boolean;
}

export interface ContextInjectionPlanResult extends ContextInjectionConsumeResult {
  consumedKeys: string[];
  planTelemetry: ContextInjectionPlanTelemetry;
}

export interface ContextInjectionRegisterResult {
  accepted: boolean;
  sloEnforced?: {
    entriesBefore: number;
    entriesAfter: number;
    dropped: boolean;
  };
}

export class ContextInjectionCollector {
  private readonly arena: ContextArena;

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      maxEntriesPerSession?: number;
    } = {},
  ) {
    this.arena = new ContextArena({
      sourceTokenLimits: options.sourceTokenLimits,
      maxEntriesPerSession: options.maxEntriesPerSession,
    });
  }

  register(
    sessionId: string,
    input: RegisterContextInjectionInput,
  ): ContextInjectionRegisterResult {
    return this.arena.append(sessionId, input);
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
    this.arena.clearSession(sessionId);
  }

  clearSession(sessionId: string): void {
    this.arena.clearSession(sessionId);
  }
}
