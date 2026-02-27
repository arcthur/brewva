import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  ContextInjectionPriority,
  ContextInjectionTruncationStrategy,
  RegisterContextInjectionInput,
} from "./injection.js";
import {
  ZoneBudgetAllocator,
  type ZoneBudgetAllocationResult,
  type ZoneBudgetConfig,
} from "./zone-budget.js";
import { zoneForSource, zoneOrderIndex, type ContextZone } from "./zones.js";

const ENTRY_SEPARATOR = "\n\n";
const ARENA_TRIM_MIN_ENTRIES = 2_048;
const ARENA_TRIM_MIN_SUPERSEDED = 512;
const ARENA_TRIM_MIN_SUPERSEDED_RATIO = 0.25;

const PRIORITY_ORDER: Record<ContextInjectionPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

interface ArenaEntry extends ContextInjectionEntry {
  key: string;
  index: number;
  presented: boolean;
}

interface ArenaSessionState {
  entries: ArenaEntry[];
  latestIndexByKey: Map<string, number>;
  onceKeys: Set<string>;
}

type ZoneTokenMap = Record<ContextZone, number>;
type ZonePlanState =
  | { kind: "disabled" }
  | { kind: "floor_unmet" }
  | { kind: "ready"; remaining: ZoneTokenMap };

export interface ArenaSnapshot {
  totalAppended: number;
  activeKeys: number;
  onceKeys: number;
}

export class ContextArena {
  private readonly sourceTokenLimits: Record<string, number>;
  private readonly truncationStrategy: ContextInjectionTruncationStrategy;
  private readonly zoneLayout: boolean;
  private readonly zoneBudgetAllocator: ZoneBudgetAllocator | null;
  private readonly sessions = new Map<string, ArenaSessionState>();

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      truncationStrategy?: ContextInjectionTruncationStrategy;
      zoneLayout?: boolean;
      zoneBudgets?: ZoneBudgetConfig;
    } = {},
  ) {
    this.sourceTokenLimits = options.sourceTokenLimits ? { ...options.sourceTokenLimits } : {};
    this.truncationStrategy = options.truncationStrategy ?? "summarize";
    this.zoneLayout = options.zoneLayout === true;
    this.zoneBudgetAllocator = options.zoneBudgets
      ? new ZoneBudgetAllocator(options.zoneBudgets)
      : null;
  }

  append(sessionId: string, input: RegisterContextInjectionInput): void {
    const source = input.source.trim();
    const id = input.id.trim();
    if (!sessionId || !source || !id) return;

    const content = input.content.trim();
    if (!content) return;

    const key = `${source}:${id}`;
    const oncePerSession = input.oncePerSession === true;
    const state = this.getOrCreateSession(sessionId);
    if (oncePerSession && state.onceKeys.has(key)) {
      return;
    }

    let entry: ContextInjectionEntry = {
      source,
      id,
      content,
      priority: input.priority ?? "normal",
      estimatedTokens: estimateTokenCount(content),
      timestamp: Date.now(),
      oncePerSession,
      truncated: false,
    };

    const sourceLimit = this.resolveSourceLimit(source);
    if (Number.isFinite(sourceLimit) && entry.estimatedTokens > sourceLimit) {
      const fitted = this.fitEntryToBudget(entry, sourceLimit);
      if (!fitted) return;
      entry = fitted;
    }

    if (entry.estimatedTokens <= 0) return;

    const arenaEntry: ArenaEntry = {
      ...entry,
      key,
      index: state.entries.length,
      presented: false,
    };
    state.entries.push(arenaEntry);
    state.latestIndexByKey.set(key, arenaEntry.index);
    this.maybeTrimSupersededEntries(state);
  }

  plan(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult {
    const state = this.sessions.get(sessionId);
    if (!state || state.latestIndexByKey.size === 0) {
      return { text: "", entries: [], estimatedTokens: 0, truncated: false, consumedKeys: [] };
    }

    const candidates: ArenaEntry[] = [];
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry || entry.presented) continue;
      candidates.push(entry);
    }
    if (candidates.length === 0) {
      return { text: "", entries: [], estimatedTokens: 0, truncated: false, consumedKeys: [] };
    }

    candidates.sort((left, right) => {
      if (this.zoneLayout) {
        const leftZone = zoneOrderIndex(zoneForSource(left.source));
        const rightZone = zoneOrderIndex(zoneForSource(right.source));
        if (leftZone !== rightZone) return leftZone - rightZone;
      }
      const byPriority = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
      if (byPriority !== 0) return byPriority;
      return left.timestamp - right.timestamp;
    });

    const separatorTokens = estimateTokenCount(ENTRY_SEPARATOR);
    let remainingTokens = Math.max(0, Math.floor(totalTokenBudget));
    let truncated = false;
    const consumedKeys: string[] = [];
    const accepted: ContextInjectionEntry[] = [];
    const zonePlan = this.buildZoneRemaining(candidates, remainingTokens);
    if (zonePlan.kind === "floor_unmet") {
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planReason: "floor_unmet",
      };
    }

    for (const entry of candidates) {
      const separatorCost = accepted.length > 0 ? separatorTokens : 0;
      if (remainingTokens <= separatorCost) {
        truncated = true;
        break;
      }

      const zone = zoneForSource(entry.source);
      // Zone allocations are content-only by design; separator tokens are charged
      // only against the global budget to avoid over-coupling zone math to join costs.
      const globalEntryBudget = Math.max(0, remainingTokens - separatorCost);
      const zoneBudget = zonePlan.kind === "ready" ? zonePlan.remaining[zone] : globalEntryBudget;
      const entryBudget = Math.max(0, Math.min(globalEntryBudget, zoneBudget));
      if (entryBudget <= 0) {
        truncated = true;
        continue;
      }
      if (entry.estimatedTokens <= entryBudget) {
        consumedKeys.push(entry.key);
        accepted.push(this.toPublicEntry(entry));
        remainingTokens = Math.max(0, remainingTokens - separatorCost - entry.estimatedTokens);
        if (zonePlan.kind === "ready") {
          zonePlan.remaining[zone] = Math.max(0, zonePlan.remaining[zone] - entry.estimatedTokens);
        }
        continue;
      }

      const fitted = this.fitEntryToBudget(entry, entryBudget);
      truncated = true;
      if (fitted) {
        consumedKeys.push(entry.key);
        accepted.push(fitted);
        remainingTokens = Math.max(0, remainingTokens - separatorCost - fitted.estimatedTokens);
        if (zonePlan.kind === "ready") {
          zonePlan.remaining[zone] = Math.max(0, zonePlan.remaining[zone] - fitted.estimatedTokens);
        }

        if (this.truncationStrategy === "tail") {
          break;
        }
        continue;
      }

      if (this.truncationStrategy === "drop-entry" || this.truncationStrategy === "summarize") {
        continue;
      }
      break;
    }

    const text = accepted.map((entry) => entry.content).join(ENTRY_SEPARATOR);
    return {
      text,
      entries: accepted,
      estimatedTokens: estimateTokenCount(text),
      truncated,
      consumedKeys,
    };
  }

  markPresented(sessionId: string, consumedKeys: string[]): void {
    if (consumedKeys.length === 0) return;
    const state = this.sessions.get(sessionId);
    if (!state) return;

    for (const key of consumedKeys) {
      const index = state.latestIndexByKey.get(key);
      if (index === undefined) continue;
      const entry = state.entries[index];
      if (!entry) continue;
      entry.presented = true;
      if (entry.oncePerSession) {
        state.onceKeys.add(key);
      }
    }
  }

  clearPending(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry) continue;
      if (entry.oncePerSession && state.onceKeys.has(entry.key)) {
        continue;
      }
      entry.presented = false;
    }
  }

  resetEpoch(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): ArenaSnapshot {
    const state = this.sessions.get(sessionId);
    if (!state) {
      return {
        totalAppended: 0,
        activeKeys: 0,
        onceKeys: 0,
      };
    }
    return {
      totalAppended: state.entries.length,
      activeKeys: state.latestIndexByKey.size,
      onceKeys: state.onceKeys.size,
    };
  }

  private fitEntryToBudget(
    entry: ContextInjectionEntry,
    tokenBudget: number,
  ): ContextInjectionEntry | null {
    const budget = Math.max(0, Math.floor(tokenBudget));
    if (budget <= 0) return null;
    if (entry.estimatedTokens <= budget) {
      return this.toPublicEntry(entry);
    }

    if (this.truncationStrategy === "drop-entry") {
      return null;
    }

    if (this.truncationStrategy === "summarize") {
      const summary = truncateTextToTokenBudget(this.buildTruncatedSummary(entry), budget);
      const summaryTokens = estimateTokenCount(summary);
      if (summaryTokens <= 0) return null;
      return {
        ...this.toPublicEntry(entry),
        content: summary,
        estimatedTokens: summaryTokens,
        truncated: true,
      };
    }

    const partialText = truncateTextToTokenBudget(entry.content, budget);
    const partialTokens = estimateTokenCount(partialText);
    if (partialTokens <= 0) return null;
    return {
      ...this.toPublicEntry(entry),
      content: partialText,
      estimatedTokens: partialTokens,
      truncated: true,
    };
  }

  private buildTruncatedSummary(entry: ContextInjectionEntry): string {
    return [
      "[ContextTruncated]",
      `source=${entry.source}`,
      `id=${entry.id}`,
      `originalTokens=${entry.estimatedTokens}`,
      "reason=budget_limit",
    ].join("\n");
  }

  private resolveSourceLimit(source: string): number {
    const configured = this.sourceTokenLimits[source];
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(0, Math.floor(configured));
  }

  private getOrCreateSession(sessionId: string): ArenaSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: ArenaSessionState = {
      entries: [],
      latestIndexByKey: new Map(),
      onceKeys: new Set(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private toPublicEntry(entry: ContextInjectionEntry): ContextInjectionEntry {
    return {
      source: entry.source,
      id: entry.id,
      content: entry.content,
      priority: entry.priority,
      estimatedTokens: entry.estimatedTokens,
      timestamp: entry.timestamp,
      oncePerSession: entry.oncePerSession,
      truncated: entry.truncated,
    };
  }

  private buildZoneRemaining(candidates: ArenaEntry[], totalBudget: number): ZonePlanState {
    if (!this.zoneLayout || !this.zoneBudgetAllocator) {
      return { kind: "disabled" };
    }

    const zoneDemands: ZoneTokenMap = {
      identity: 0,
      truth: 0,
      task_state: 0,
      tool_failures: 0,
      memory_working: 0,
      memory_recall: 0,
    };
    for (const candidate of candidates) {
      const zone = zoneForSource(candidate.source);
      zoneDemands[zone] += candidate.estimatedTokens;
    }

    const allocation = this.zoneBudgetAllocator.allocate({
      totalBudget,
      zoneDemands,
    });
    if (!allocation.accepted) {
      return { kind: "floor_unmet" };
    }
    return {
      kind: "ready",
      remaining: this.toZoneRemaining(allocation),
    };
  }

  private maybeTrimSupersededEntries(state: ArenaSessionState): void {
    const totalEntries = state.entries.length;
    if (totalEntries < ARENA_TRIM_MIN_ENTRIES) return;

    const latestIndices = new Set(state.latestIndexByKey.values());
    const supersededCount = totalEntries - latestIndices.size;
    if (supersededCount < ARENA_TRIM_MIN_SUPERSEDED) return;
    if (supersededCount / totalEntries < ARENA_TRIM_MIN_SUPERSEDED_RATIO) return;

    const compactedEntries: ArenaEntry[] = [];
    const nextLatestIndexByKey = new Map<string, number>();

    for (const entry of state.entries) {
      if (!latestIndices.has(entry.index)) continue;
      const nextIndex = compactedEntries.length;
      compactedEntries.push({
        ...entry,
        index: nextIndex,
      });
      nextLatestIndexByKey.set(entry.key, nextIndex);
    }

    state.entries = compactedEntries;
    state.latestIndexByKey = nextLatestIndexByKey;
  }

  private toZoneRemaining(allocation: ZoneBudgetAllocationResult): ZoneTokenMap {
    return {
      identity: allocation.identity,
      truth: allocation.truth,
      task_state: allocation.task_state,
      tool_failures: allocation.tool_failures,
      memory_working: allocation.memory_working,
      memory_recall: allocation.memory_recall,
    };
  }
}
