import type { BrewvaEventRecord } from "../types.js";
import { extractMemoryFromEvent } from "./extractor.js";
import { MemoryStore } from "./store.js";
import type { WorkingMemorySnapshot } from "./types.js";
import { buildWorkingMemorySnapshot } from "./working-memory.js";

export interface MemoryEngineOptions {
  enabled: boolean;
  rootDir: string;
  workingFile: string;
  maxWorkingChars: number;
  recordEvent?: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }) => void;
}

export interface MemoryRebuildFromTapeResult {
  rebuilt: boolean;
  reason: "disabled" | "already_present" | "no_replayable_events" | "replayed";
  scannedEvents: number;
  replayedEvents: number;
  upsertedUnits: number;
  resolvedUnits: number;
}

export class MemoryEngine {
  private readonly enabled: boolean;
  private readonly rootDir: string;
  private readonly workingFile: string;
  private readonly maxWorkingChars: number;
  private readonly recordEvent?: MemoryEngineOptions["recordEvent"];
  private store: MemoryStore | null = null;
  private readonly dirtySessions = new Set<string>();

  constructor(options: MemoryEngineOptions) {
    this.enabled = options.enabled;
    this.rootDir = options.rootDir;
    this.workingFile = options.workingFile;
    this.maxWorkingChars = Math.max(200, options.maxWorkingChars);
    this.recordEvent = options.recordEvent;
  }

  ingestEvent(event: BrewvaEventRecord): void {
    if (!this.enabled) return;

    const extraction = extractMemoryFromEvent(event);
    if (extraction.upserts.length === 0 && extraction.resolves.length === 0) return;

    const result = this.getStore().ingestExtraction(extraction, event.timestamp);
    this.dirtySessions.add(event.sessionId);

    this.recordEvent?.({
      sessionId: event.sessionId,
      type: "memory_projection_ingested",
      turn: event.turn,
      payload: {
        sourceEventId: event.id,
        sourceType: event.type,
        upsertedUnits: result.upsertedUnits,
        resolvedUnits: result.resolvedUnits,
      },
    });
  }

  getWorkingMemory(sessionId: string): WorkingMemorySnapshot | undefined {
    if (!this.enabled) return undefined;
    return this.getStore().getWorkingSnapshot(sessionId);
  }

  refreshIfNeeded(input: {
    sessionId: string;
    force?: boolean;
  }): WorkingMemorySnapshot | undefined {
    if (!this.enabled) return undefined;

    const force = input.force === true;
    const store = this.getStore();
    if (!force && !this.dirtySessions.has(input.sessionId)) {
      return store.getWorkingSnapshot(input.sessionId);
    }

    const units = store.listUnits(input.sessionId);
    const snapshot = buildWorkingMemorySnapshot({
      sessionId: input.sessionId,
      units,
      maxChars: this.maxWorkingChars,
    });

    store.setWorkingSnapshot(snapshot);
    this.dirtySessions.delete(input.sessionId);
    this.recordEvent?.({
      sessionId: input.sessionId,
      type: "memory_projection_refreshed",
      payload: {
        unitCount: units.length,
        chars: snapshot.content.length,
      },
    });
    return snapshot;
  }

  clearSessionCache(sessionId: string): void {
    if (!this.enabled || !this.store) return;
    this.dirtySessions.delete(sessionId);
    this.store.clearWorkingSnapshot(sessionId);
  }

  rebuildSessionFromTape(input: {
    sessionId: string;
    events: BrewvaEventRecord[];
    mode?: "missing_only" | "always";
  }): MemoryRebuildFromTapeResult {
    if (!this.enabled) {
      return {
        rebuilt: false,
        reason: "disabled",
        scannedEvents: 0,
        replayedEvents: 0,
        upsertedUnits: 0,
        resolvedUnits: 0,
      };
    }

    const store = this.getStore();
    const mode = input.mode ?? "missing_only";
    if (mode === "missing_only" && store.hasUnits(input.sessionId)) {
      return {
        rebuilt: false,
        reason: "already_present",
        scannedEvents: input.events.length,
        replayedEvents: 0,
        upsertedUnits: 0,
        resolvedUnits: 0,
      };
    }

    let replayedEvents = 0;
    let upsertedUnits = 0;
    let resolvedUnits = 0;

    for (const event of input.events) {
      const extraction = extractMemoryFromEvent(event);
      if (extraction.upserts.length === 0 && extraction.resolves.length === 0) continue;
      replayedEvents += 1;
      const ingested = store.ingestExtraction(extraction, event.timestamp);
      upsertedUnits += ingested.upsertedUnits;
      resolvedUnits += ingested.resolvedUnits;
    }

    if (replayedEvents === 0) {
      return {
        rebuilt: false,
        reason: "no_replayable_events",
        scannedEvents: input.events.length,
        replayedEvents: 0,
        upsertedUnits,
        resolvedUnits,
      };
    }

    this.dirtySessions.add(input.sessionId);
    this.refreshIfNeeded({ sessionId: input.sessionId, force: true });

    return {
      rebuilt: true,
      reason: "replayed",
      scannedEvents: input.events.length,
      replayedEvents,
      upsertedUnits,
      resolvedUnits,
    };
  }

  private getStore(): MemoryStore {
    if (!this.store) {
      this.store = new MemoryStore({
        rootDir: this.rootDir,
        workingFile: this.workingFile,
      });
    }
    return this.store;
  }
}
