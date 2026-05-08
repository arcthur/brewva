import { sha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeCallback } from "../../runtime/callback.js";
import {
  readWorkbenchBaselineCommittedEventPayload,
  readWorkbenchEvictionRecordedEventPayload,
  readWorkbenchEvictionUndoneEventPayload,
  readWorkbenchNoteRecordedEventPayload,
} from "./event-descriptors.js";
import {
  WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
} from "./events.js";
import {
  listInvalidWorkbenchEvictionSpanRefs,
  normalizeWorkbenchEvictionSpanRefs,
} from "./span-refs.js";
import type {
  WorkbenchEntry,
  WorkbenchEvictInput,
  WorkbenchNoteInput,
  WorkbenchUndoEvictionResult,
} from "./types.js";

interface WorkbenchServiceOptions {
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: object;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

function dedupeWorkbenchEntries(entries: readonly WorkbenchEntry[]): WorkbenchEntry[] {
  const byId = new Map<string, WorkbenchEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function isWorkbenchEntryReversible(kind: WorkbenchEntry["kind"]): boolean {
  return kind === "eviction";
}

export class WorkbenchService {
  private readonly entriesBySession = new Map<string, WorkbenchEntry[]>();
  private readonly getCurrentTurn: WorkbenchServiceOptions["getCurrentTurn"];
  private readonly recordEvent: WorkbenchServiceOptions["recordEvent"];

  constructor(options: WorkbenchServiceOptions) {
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  note(sessionId: string, input: WorkbenchNoteInput): WorkbenchEntry {
    const turn = this.getCurrentTurn(sessionId);
    const entry = this.createEntry(sessionId, {
      kind: "note",
      content: input.content,
      sourceRefs: input.sourceRefs ?? [],
      reason: input.reason,
      turn,
      preservedQuotes: undefined,
    });
    this.append(sessionId, entry);
    this.recordEvent({
      sessionId,
      type: WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
      turn,
      payload: {
        id: entry.id,
        digest: entry.digest,
        content: entry.content,
        sourceRefs: entry.sourceRefs,
        reason: entry.reason,
        retentionHint: input.retentionHint,
      },
    });
    return structuredClone(entry);
  }

  evict(sessionId: string, input: WorkbenchEvictInput): WorkbenchEntry {
    const invalidRefs = listInvalidWorkbenchEvictionSpanRefs(input.spanRefs);
    if (invalidRefs.length > 0) {
      throw new Error(`invalid_workbench_eviction_span_refs:${invalidRefs.join(",")}`);
    }
    const turn = this.getCurrentTurn(sessionId);
    const entry = this.createEntry(sessionId, {
      kind: "eviction",
      content: input.replacementNote ?? "",
      sourceRefs: normalizeWorkbenchEvictionSpanRefs(input.spanRefs),
      reason: input.reason,
      turn,
      preservedQuotes: input.preservedQuotes ?? [],
    });
    this.append(sessionId, entry);
    this.recordEvent({
      sessionId,
      type: WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
      turn,
      payload: {
        id: entry.id,
        digest: entry.digest,
        replacementNote: entry.content,
        spanRefs: entry.sourceRefs,
        reason: entry.reason,
        preservedQuotes: entry.preservedQuotes ?? [],
      },
    });
    return structuredClone(entry);
  }

  undoEviction(sessionId: string, entryId: string, reason?: string): WorkbenchUndoEvictionResult {
    const entries = this.entriesBySession.get(sessionId) ?? [];
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || entry.kind !== "eviction" || !entry.reversible || entry.baselineCommitted) {
      return { undone: false };
    }
    const nextEntries = entries.filter((candidate) => candidate.id !== entryId);
    this.entriesBySession.set(sessionId, nextEntries);
    const turn = this.getCurrentTurn(sessionId);
    this.recordEvent({
      sessionId,
      type: WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
      turn,
      payload: {
        id: entry.id,
        digest: entry.digest,
        reason,
      },
    });
    return {
      undone: true,
      entry: {
        ...structuredClone(entry),
        undoneAtTurn: turn,
      },
    };
  }

  commitBaseline(sessionId: string): WorkbenchEntry[] {
    const entries = dedupeWorkbenchEntries(this.entriesBySession.get(sessionId) ?? []);
    const committed = entries.map((entry) => {
      const nextEntry = structuredClone(entry);
      nextEntry.reversible = false;
      nextEntry.baselineCommitted = true;
      return nextEntry;
    });
    this.entriesBySession.set(sessionId, committed);
    this.recordEvent({
      sessionId,
      type: WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        entryIds: committed.map((entry) => entry.id),
      },
    });
    return structuredClone(committed);
  }

  list(sessionId: string): WorkbenchEntry[] {
    return structuredClone(dedupeWorkbenchEntries(this.entriesBySession.get(sessionId) ?? []));
  }

  clear(sessionId: string): void {
    this.entriesBySession.delete(sessionId);
  }

  restoreFromEvents(sessionId: string, events: readonly BrewvaEventRecord[]): void {
    const entries: WorkbenchEntry[] = [];
    for (const event of events) {
      if (event.type === WORKBENCH_NOTE_RECORDED_EVENT_TYPE) {
        const payload = readWorkbenchNoteRecordedEventPayload(event);
        if (!payload) continue;
        entries.push({
          id: payload.id,
          kind: "note",
          content: payload.content,
          sourceRefs: payload.sourceRefs,
          reason: payload.reason,
          createdTurn: normalizeEventTurn(event.turn),
          digest: payload.digest,
          reversible: false,
          baselineCommitted: false,
        });
        continue;
      }
      if (event.type === WORKBENCH_EVICTION_RECORDED_EVENT_TYPE) {
        const payload = readWorkbenchEvictionRecordedEventPayload(event);
        if (!payload) continue;
        entries.push({
          id: payload.id,
          kind: "eviction",
          content: payload.replacementNote,
          sourceRefs: payload.spanRefs,
          reason: payload.reason,
          createdTurn: normalizeEventTurn(event.turn),
          digest: payload.digest,
          reversible: true,
          baselineCommitted: false,
          ...(payload.preservedQuotes.length > 0
            ? { preservedQuotes: payload.preservedQuotes }
            : {}),
        });
        continue;
      }
      if (event.type === WORKBENCH_EVICTION_UNDONE_EVENT_TYPE) {
        const payload = readWorkbenchEvictionUndoneEventPayload(event);
        if (!payload) continue;
        const index = entries.findIndex(
          (entry) => entry.id === payload.id && entry.kind === "eviction",
        );
        if (index >= 0) {
          entries.splice(index, 1);
        }
        continue;
      }
      if (event.type === WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE) {
        const payload = readWorkbenchBaselineCommittedEventPayload(event);
        if (!payload) continue;
        const committedIds = new Set(payload.entryIds);
        for (const entry of entries) {
          if (committedIds.has(entry.id)) {
            entry.reversible = false;
            entry.baselineCommitted = true;
          }
        }
      }
    }
    this.entriesBySession.set(sessionId, structuredClone(dedupeWorkbenchEntries(entries)));
  }

  private append(sessionId: string, entry: WorkbenchEntry): void {
    const entries = this.entriesBySession.get(sessionId) ?? [];
    this.entriesBySession.set(sessionId, dedupeWorkbenchEntries([...entries, entry]));
  }

  private createEntry(
    sessionId: string,
    input: {
      kind: WorkbenchEntry["kind"];
      content: string;
      sourceRefs: readonly string[];
      reason: string;
      turn: number;
      preservedQuotes?: readonly string[];
    },
  ): WorkbenchEntry {
    const sourceRefs = normalizeStringList(input.sourceRefs);
    const preservedQuotes = normalizeStringList(input.preservedQuotes ?? []);
    const content = input.content.trim();
    const reason = input.reason.trim();
    const digest = sha256Hex(
      JSON.stringify({
        kind: input.kind,
        content,
        sourceRefs,
        reason,
        preservedQuotes,
      }),
    );
    return {
      id: `wb_${input.turn}_${digest.slice(0, 12)}`,
      kind: input.kind,
      content,
      sourceRefs,
      reason,
      createdTurn: input.turn,
      digest,
      reversible: isWorkbenchEntryReversible(input.kind),
      baselineCommitted: false,
      ...(preservedQuotes.length > 0 ? { preservedQuotes } : {}),
    };
  }
}

function normalizeStringList(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeEventTurn(turn: unknown): number {
  return typeof turn === "number" && Number.isFinite(turn) ? Math.max(0, Math.trunc(turn)) : 0;
}
