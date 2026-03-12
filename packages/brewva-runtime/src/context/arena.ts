import { estimateTokenCount, truncateTextToTokenBudget } from "../utils/token.js";
import type {
  ContextInjectionEntry,
  ContextInjectionPlanResult,
  ContextInjectionRegisterResult,
  RegisterContextInjectionInput,
} from "./injection.js";

const ENTRY_SEPARATOR = "\n\n";
const ARENA_TRIM_MIN_ENTRIES = 2_048;
const ARENA_TRIM_MIN_SUPERSEDED = 512;
const ARENA_TRIM_MIN_SUPERSEDED_RATIO = 0.25;

interface ArenaEntry extends ContextInjectionEntry {
  key: string;
  index: number;
  presented: boolean;
}

interface ArenaSessionState {
  entries: ArenaEntry[];
  latestIndexByKey: Map<string, number>;
  onceKeys: Set<string>;
  lastDegradationApplied: boolean;
}

interface ArenaCapacityDecision {
  allow: boolean;
  entriesBefore: number;
  entriesAfter: number;
  dropped: boolean;
  degradationApplied: boolean;
  replaceIndex?: number;
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
      id,
      content,
      estimatedTokens: estimateTokenCount(content),
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
    const arenaEntry: ArenaEntry = {
      ...entry,
      key,
      index: replaceIndex ?? state.entries.length,
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

    const candidates = allCandidates;

    const separatorTokens = estimateTokenCount(ENTRY_SEPARATOR);
    let remainingTokens = Math.max(0, Math.floor(totalTokenBudget));
    let truncated = false;
    const consumedKeys: string[] = [];
    const accepted: ContextInjectionEntry[] = [];

    for (const entry of candidates) {
      const separatorCost = accepted.length > 0 ? separatorTokens : 0;
      if (remainingTokens <= separatorCost) {
        truncated = true;
        break;
      }

      const entryBudget = Math.max(0, remainingTokens - separatorCost);
      if (entryBudget <= 0) {
        truncated = true;
        continue;
      }
      if (entry.estimatedTokens <= entryBudget) {
        consumedKeys.push(entry.key);
        accepted.push(this.toPublicEntry(entry));
        remainingTokens = Math.max(0, remainingTokens - separatorCost - entry.estimatedTokens);
        continue;
      }

      const fitted = this.fitEntryToBudget(entry, entryBudget);
      truncated = true;
      if (fitted) {
        consumedKeys.push(entry.key);
        accepted.push(fitted);
        break;
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
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private toPublicEntry(entry: ContextInjectionEntry): ContextInjectionEntry {
    return {
      source: entry.source,
      category: entry.category,
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
}
