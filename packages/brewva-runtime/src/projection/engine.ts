import type { BrewvaEventRecord } from "../contracts/index.js";
import {
  PROJECTION_INGESTED_EVENT_TYPE,
  PROJECTION_REFRESHED_EVENT_TYPE,
} from "../events/event-types.js";
import { extractProjectionFromEvent } from "./extractor.js";
import { ProjectionStore } from "./store.js";
import type { WorkingProjectionSnapshot } from "./types.js";
import { buildWorkingProjectionSnapshot } from "./working-projection.js";

export interface ProjectionEngineOptions {
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

export interface ProjectionRebuildFromTapeResult {
  rebuilt: boolean;
  reason: "disabled" | "already_present" | "no_replayable_events" | "replayed";
  scannedEvents: number;
  replayedEvents: number;
  upsertedUnits: number;
  resolvedUnits: number;
}

export class ProjectionEngine {
  private readonly enabled: boolean;
  private readonly rootDir: string;
  private readonly workingFile: string;
  private readonly maxWorkingChars: number;
  private readonly recordEvent?: ProjectionEngineOptions["recordEvent"];
  private store: ProjectionStore | null = null;
  private readonly dirtySessions = new Set<string>();

  constructor(options: ProjectionEngineOptions) {
    this.enabled = options.enabled;
    this.rootDir = options.rootDir;
    this.workingFile = options.workingFile;
    this.maxWorkingChars = Math.max(200, options.maxWorkingChars);
    this.recordEvent = options.recordEvent;
  }

  ingestEvent(event: BrewvaEventRecord): void {
    if (!this.enabled) return;

    const extraction = extractProjectionFromEvent(event);
    if (extraction.upserts.length === 0 && extraction.resolves.length === 0) return;

    const result = this.getStore().ingestExtraction(extraction, event.timestamp);
    this.dirtySessions.add(event.sessionId);

    this.recordEvent?.({
      sessionId: event.sessionId,
      type: PROJECTION_INGESTED_EVENT_TYPE,
      turn: event.turn,
      payload: {
        sourceEventId: event.id,
        sourceType: event.type,
        upsertedUnits: result.upsertedUnits,
        resolvedUnits: result.resolvedUnits,
      },
    });
  }

  getWorkingProjection(sessionId: string): WorkingProjectionSnapshot | undefined {
    if (!this.enabled) return undefined;
    return this.getStore().getWorkingSnapshot(sessionId);
  }

  refreshIfNeeded(input: {
    sessionId: string;
    force?: boolean;
  }): WorkingProjectionSnapshot | undefined {
    if (!this.enabled) return undefined;

    const force = input.force === true;
    const store = this.getStore();
    const cached = store.getWorkingSnapshot(input.sessionId);
    if (!force && !this.dirtySessions.has(input.sessionId)) {
      if (cached) return cached;
      if (!store.hasUnits(input.sessionId)) return undefined;
    }

    const units = store.listUnits(input.sessionId);
    const activeUnitCount = units.filter((unit) => unit.status === "active").length;
    const snapshot = buildWorkingProjectionSnapshot({
      sessionId: input.sessionId,
      units,
      maxChars: this.maxWorkingChars,
    });

    store.setWorkingSnapshot(snapshot);
    this.dirtySessions.delete(input.sessionId);
    this.recordEvent?.({
      sessionId: input.sessionId,
      type: PROJECTION_REFRESHED_EVENT_TYPE,
      payload: {
        unitCount: activeUnitCount,
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
  }): ProjectionRebuildFromTapeResult {
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
      const extraction = extractProjectionFromEvent(event);
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

  private getStore(): ProjectionStore {
    if (!this.store) {
      this.store = new ProjectionStore({
        rootDir: this.rootDir,
        workingFile: this.workingFile,
      });
    }
    return this.store;
  }
}
