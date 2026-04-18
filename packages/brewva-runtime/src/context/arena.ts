import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  ContextInjectionRegisterResult,
  RegisterContextInjectionInput,
} from "./injection.js";
import type { ContextInjectionBudgetClass } from "./sources.js";

const ENTRY_SEPARATOR = "\n\n";
const ARENA_TRIM_MIN_ENTRIES = 2_048;
const ARENA_TRIM_MIN_SUPERSEDED = 512;
const ARENA_TRIM_MIN_SUPERSEDED_RATIO = 0.25;
const BUDGET_CLASS_ORDER: ContextInjectionBudgetClass[] = ["core", "working", "recall"];
const BUDGET_CLASS_FLOORS: Record<ContextInjectionBudgetClass, number> = {
  core: 0.36,
  working: 0.16,
  recall: 0,
};
const BUDGET_CLASS_SOFT_CAPS: Record<ContextInjectionBudgetClass, number> = {
  core: 0.58,
  working: 0.36,
  recall: 0.24,
};

interface ArenaEntry extends ContextInjectionEntry {
  key: string;
  index: number;
  order: number;
  presented: boolean;
}

interface ArenaSessionState {
  entries: ArenaEntry[];
  latestIndexByKey: Map<string, number>;
  onceKeys: Set<string>;
  lastDegradationApplied: boolean;
  nextOrder: number;
}

interface ArenaCapacityDecision {
  allow: boolean;
  entriesBefore: number;
  entriesAfter: number;
  dropped: boolean;
  degradationApplied: boolean;
  replaceIndex?: number;
}

interface ReservedSourceBudgetState {
  budgetClass: ContextInjectionBudgetClass;
  remainingTokens: number;
}

export interface ArenaSnapshot {
  totalAppended: number;
  activeKeys: number;
  onceKeys: number;
}

export class ContextArena {
  private readonly sourceTokenLimits: Record<string, number>;
  private readonly maxEntriesPerSession: number;
  private readonly sessions = new Map<string, ArenaSessionState>();

  constructor(
    options: {
      sourceTokenLimits?: Record<string, number>;
      maxEntriesPerSession?: number;
    } = {},
  ) {
    this.sourceTokenLimits = options.sourceTokenLimits ? { ...options.sourceTokenLimits } : {};
    this.maxEntriesPerSession = Math.max(1, Math.floor(options.maxEntriesPerSession ?? 4096));
  }

  append(sessionId: string, input: RegisterContextInjectionInput): ContextInjectionRegisterResult {
    const source = input.source.trim();
    const id = input.id.trim();
    if (!sessionId || !source || !id) return { accepted: false };

    const content = input.content.trim();
    if (!content) return { accepted: false };

    const key = `${source}:${id}`;
    const oncePerSession = input.oncePerSession === true;
    const state = this.getOrCreateSession(sessionId);
    if (oncePerSession && state.onceKeys.has(key)) {
      return { accepted: false };
    }

    let entry: ContextInjectionEntry = {
      source,
      category: input.category,
      budgetClass: input.budgetClass,
      selectionPriority: this.normalizePriority(input.selectionPriority),
      preservationPolicy: input.preservationPolicy,
      reservedBudgetRatio: this.normalizeReservedBudgetRatio(input.reservedBudgetRatio),
      id,
      content,
      estimatedTokens: this.resolveEstimatedTokens(input.estimatedTokens, content),
      timestamp: Date.now(),
      oncePerSession,
      truncated: false,
    };

    const sourceLimit = this.resolveSourceLimit(source);
    if (Number.isFinite(sourceLimit) && entry.estimatedTokens > sourceLimit) {
      const fitted = this.fitEntryToBudget(entry, sourceLimit);
      if (!fitted) return { accepted: false };
      entry = fitted;
    }

    if (entry.estimatedTokens <= 0) return { accepted: false };

    const capacity = this.ensureAppendCapacity(state, key);
    if (!capacity.allow) {
      return {
        accepted: false,
        sloEnforced: capacity.degradationApplied
          ? {
              entriesBefore: capacity.entriesBefore,
              entriesAfter: capacity.entriesAfter,
              dropped: capacity.dropped,
            }
          : undefined,
      };
    }

    const replaceIndex = capacity.replaceIndex;
    const previousIndex = state.latestIndexByKey.get(key);
    const previousEntry = previousIndex !== undefined ? state.entries[previousIndex] : undefined;
    const order = previousEntry?.order ?? state.nextOrder++;
    const arenaEntry: ArenaEntry = {
      ...entry,
      key,
      index: replaceIndex ?? state.entries.length,
      order,
      presented: false,
    };
    if (typeof replaceIndex === "number") {
      state.entries[replaceIndex] = arenaEntry;
      state.latestIndexByKey.set(key, replaceIndex);
      return {
        accepted: true,
      };
    }
    state.entries.push(arenaEntry);
    state.latestIndexByKey.set(key, arenaEntry.index);
    this.maybeTrimSupersededEntries(state);

    return {
      accepted: true,
      sloEnforced: capacity.degradationApplied
        ? {
            entriesBefore: capacity.entriesBefore,
            entriesAfter: capacity.entriesAfter,
            dropped: capacity.dropped,
          }
        : undefined,
    };
  }

  plan(sessionId: string, totalTokenBudget: number): ContextInjectionPlanResult {
    const state = this.sessions.get(sessionId);
    if (!state || state.latestIndexByKey.size === 0) {
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planTelemetry: this.emptyPlanTelemetry(),
      };
    }

    const allCandidates: ArenaEntry[] = [];
    for (const index of state.latestIndexByKey.values()) {
      const entry = state.entries[index];
      if (!entry || entry.presented) continue;
      allCandidates.push(entry);
    }
    if (allCandidates.length === 0) {
      return {
        text: "",
        entries: [],
        estimatedTokens: 0,
        truncated: false,
        consumedKeys: [],
        planTelemetry: this.consumePlanTelemetry(state, this.emptyPlanTelemetry()),
      };
    }
    allCandidates.sort((left, right) => {
      if (left.selectionPriority !== right.selectionPriority) {
        return left.selectionPriority - right.selectionPriority;
      }
      return left.order - right.order;
    });

    const classBudgets = this.allocateBudgetByClass(allCandidates, totalTokenBudget);
    const reservedBudgets = this.allocateReservedBudgetBySource(allCandidates, totalTokenBudget);
    const finalPlan = this.planEntriesAcrossClassBudgets(
      allCandidates,
      totalTokenBudget,
      classBudgets,
      reservedBudgets,
    );
    const accepted = finalPlan.entries;
    const truncated = finalPlan.truncated;
    const consumedKeys = accepted.map((entry) => `${entry.source}:${entry.id}`);

    const text = accepted.map((entry) => entry.content).join(ENTRY_SEPARATOR);
    return {
      text,
      entries: accepted,
      estimatedTokens: estimateTokenCount(text),
      truncated,
      consumedKeys,
      planTelemetry: this.consumePlanTelemetry(state, {
        degradationApplied: false,
      }),
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

  private allocateBudgetByClass(
    entries: readonly ArenaEntry[],
    totalTokenBudget: number,
  ): Record<ContextInjectionBudgetClass, number> {
    const total = Math.max(0, Math.floor(totalTokenBudget));
    const demand: Record<ContextInjectionBudgetClass, number> = {
      core: 0,
      working: 0,
      recall: 0,
    };
    for (const entry of entries) {
      demand[entry.budgetClass] += entry.estimatedTokens;
    }

    const allocated: Record<ContextInjectionBudgetClass, number> = {
      core: 0,
      working: 0,
      recall: 0,
    };
    let remaining = total;

    for (const budgetClass of BUDGET_CLASS_ORDER) {
      const floorBudget = Math.floor(total * BUDGET_CLASS_FLOORS[budgetClass]);
      const assigned = Math.min(floorBudget, demand[budgetClass], remaining);
      allocated[budgetClass] += assigned;
      remaining -= assigned;
    }

    for (const budgetClass of BUDGET_CLASS_ORDER) {
      if (remaining <= 0) {
        break;
      }
      const softCapBudget = Math.floor(total * BUDGET_CLASS_SOFT_CAPS[budgetClass]);
      const room = Math.max(0, softCapBudget - allocated[budgetClass]);
      const demandGap = Math.max(0, demand[budgetClass] - allocated[budgetClass]);
      const assigned = Math.min(room, demandGap, remaining);
      allocated[budgetClass] += assigned;
      remaining -= assigned;
    }

    for (const budgetClass of BUDGET_CLASS_ORDER) {
      if (remaining <= 0) {
        break;
      }
      const demandGap = Math.max(0, demand[budgetClass] - allocated[budgetClass]);
      if (demandGap <= 0) {
        continue;
      }
      const assigned = Math.min(demandGap, remaining);
      allocated[budgetClass] += assigned;
      remaining -= assigned;
    }

    return allocated;
  }

  private planEntriesAcrossClassBudgets(
    entries: readonly ArenaEntry[],
    totalTokenBudget: number,
    classBudgets: Record<ContextInjectionBudgetClass, number>,
    reservedBudgets: Map<string, ReservedSourceBudgetState>,
  ): { entries: ContextInjectionEntry[]; truncated: boolean } {
    const separatorTokens = estimateTokenCount(ENTRY_SEPARATOR);
    const remainingByClass: Record<ContextInjectionBudgetClass, number> = {
      core: Math.max(0, Math.floor(classBudgets.core)),
      working: Math.max(0, Math.floor(classBudgets.working)),
      recall: Math.max(0, Math.floor(classBudgets.recall)),
    };
    const remainingReservedBySource = new Map(
      [...reservedBudgets.entries()].map(([source, state]) => [source, { ...state }]),
    );
    let remainingTokens = Math.max(0, Math.floor(totalTokenBudget));
    let truncated = false;
    const accepted: ContextInjectionEntry[] = [];

    for (const entry of entries) {
      if (remainingTokens <= 0) {
        truncated = true;
        break;
      }

      const separatorCost = accepted.length > 0 ? separatorTokens : 0;
      const classBudget = remainingByClass[entry.budgetClass];
      const reservedState = remainingReservedBySource.get(entry.source);
      const reservedHoldback = [...remainingReservedBySource.values()]
        .filter((state) => state.budgetClass === entry.budgetClass)
        .reduce((sum, state) => sum + state.remainingTokens, 0);
      const availableClassBudget =
        reservedState === undefined ? Math.max(0, classBudget - reservedHoldback) : classBudget;
      const reservedTokens =
        remainingByClass.core + remainingByClass.working + remainingByClass.recall;
      const overflowBudget = Math.max(0, remainingTokens - reservedTokens);
      const sharedBudget = Math.min(remainingTokens, availableClassBudget + overflowBudget);
      if (sharedBudget <= separatorCost) {
        truncated = true;
        continue;
      }

      const entryBudget = Math.max(0, sharedBudget - separatorCost);
      if (entryBudget <= 0) {
        truncated = true;
        continue;
      }

      if (entry.estimatedTokens <= entryBudget) {
        accepted.push(this.toPublicEntry(entry));
        const consumed = separatorCost + entry.estimatedTokens;
        remainingTokens = Math.max(0, remainingTokens - consumed);
        remainingByClass[entry.budgetClass] = Math.max(0, classBudget - consumed);
        if (reservedState) {
          reservedState.remainingTokens = Math.max(0, reservedState.remainingTokens - consumed);
        }
        continue;
      }

      if (entry.preservationPolicy === "non_truncatable") {
        truncated = true;
        continue;
      }

      const fitted = this.fitEntryToBudget(entry, entryBudget);
      truncated = true;
      if (!fitted) {
        continue;
      }
      accepted.push(fitted);
      const consumed = separatorCost + fitted.estimatedTokens;
      remainingTokens = Math.max(0, remainingTokens - consumed);
      remainingByClass[entry.budgetClass] = Math.max(0, classBudget - consumed);
      if (reservedState) {
        reservedState.remainingTokens = Math.max(0, reservedState.remainingTokens - consumed);
      }
    }

    return {
      entries: accepted,
      truncated,
    };
  }

  private allocateReservedBudgetBySource(
    entries: readonly ArenaEntry[],
    totalTokenBudget: number,
  ): Map<string, ReservedSourceBudgetState> {
    const reservedBySource = new Map<string, ReservedSourceBudgetState>();
    for (const entry of entries) {
      const reservedBudget = this.resolveReservedBudget(
        entry.reservedBudgetRatio,
        totalTokenBudget,
      );
      if (reservedBudget === null) {
        continue;
      }
      reservedBySource.set(entry.source, {
        budgetClass: entry.budgetClass,
        remainingTokens: reservedBudget,
      });
    }
    return reservedBySource;
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
      lastDegradationApplied: false,
      nextOrder: 0,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private toPublicEntry(entry: ContextInjectionEntry): ContextInjectionEntry {
    return {
      source: entry.source,
      category: entry.category,
      budgetClass: entry.budgetClass,
      selectionPriority: entry.selectionPriority,
      preservationPolicy: entry.preservationPolicy,
      ...(entry.reservedBudgetRatio !== undefined
        ? { reservedBudgetRatio: entry.reservedBudgetRatio }
        : {}),
      id: entry.id,
      content: entry.content,
      estimatedTokens: entry.estimatedTokens,
      timestamp: entry.timestamp,
      oncePerSession: entry.oncePerSession,
      truncated: entry.truncated,
    };
  }

  private ensureAppendCapacity(state: ArenaSessionState, key: string): ArenaCapacityDecision {
    state.lastDegradationApplied = false;
    const before = state.entries.length;
    if (before < this.maxEntriesPerSession) {
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: before,
        dropped: false,
        degradationApplied: false,
      };
    }

    this.compactToLatest(state);
    if (state.entries.length < this.maxEntriesPerSession) {
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: state.entries.length,
        dropped: false,
        degradationApplied: false,
      };
    }

    const replaceIndex = state.latestIndexByKey.get(key);
    if (replaceIndex !== undefined) {
      return {
        allow: true,
        entriesBefore: before,
        entriesAfter: state.entries.length,
        dropped: false,
        degradationApplied: false,
        replaceIndex,
      };
    }

    state.lastDegradationApplied = true;
    return {
      allow: false,
      entriesBefore: before,
      entriesAfter: state.entries.length,
      dropped: true,
      degradationApplied: true,
    };
  }

  private compactToLatest(state: ArenaSessionState): void {
    const latestIndices = new Set(state.latestIndexByKey.values());
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

  private maybeTrimSupersededEntries(state: ArenaSessionState): void {
    const totalEntries = state.entries.length;
    if (totalEntries < ARENA_TRIM_MIN_ENTRIES) return;

    const latestIndices = new Set(state.latestIndexByKey.values());
    const supersededCount = totalEntries - latestIndices.size;
    if (supersededCount < ARENA_TRIM_MIN_SUPERSEDED) return;
    if (supersededCount / totalEntries < ARENA_TRIM_MIN_SUPERSEDED_RATIO) return;

    this.compactToLatest(state);
  }

  private emptyPlanTelemetry(): ContextInjectionPlanResult["planTelemetry"] {
    return {
      degradationApplied: false,
    };
  }

  private consumePlanTelemetry(
    state: ArenaSessionState,
    telemetry: ContextInjectionPlanResult["planTelemetry"],
  ): ContextInjectionPlanResult["planTelemetry"] {
    const degradationApplied = state.lastDegradationApplied;
    state.lastDegradationApplied = false;
    return {
      ...telemetry,
      degradationApplied,
    };
  }

  private normalizePriority(value: number): number {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }

  private normalizeReservedBudgetRatio(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.min(1, value);
  }

  private resolveEstimatedTokens(estimatedTokens: number | undefined, content: string): number {
    if (typeof estimatedTokens === "number" && Number.isFinite(estimatedTokens)) {
      return Math.max(0, Math.trunc(estimatedTokens));
    }
    return estimateTokenCount(content);
  }

  private resolveReservedBudget(
    ratio: number | undefined,
    totalTokenBudget: number,
  ): number | null {
    if (ratio === undefined) {
      return null;
    }
    const total = Math.max(0, Math.floor(totalTokenBudget));
    if (total <= 0) {
      return 0;
    }
    return Math.max(1, Math.floor(total * ratio));
  }
}
