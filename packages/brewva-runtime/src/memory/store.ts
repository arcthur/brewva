import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import type {
  MemoryExtractionResult,
  MemoryStoreState,
  MemoryUnit,
  MemoryUnitCandidate,
  MemoryUnitResolveDirective,
  WorkingMemorySnapshot,
} from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

const MEMORY_STATE_SCHEMA_VERSION = 4;

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function fingerprintForUnit(input: {
  type: MemoryUnitCandidate["type"];
  topic: string;
  statement: string;
}): string {
  return sha256(`${input.type}::${normalizeText(input.topic)}::${normalizeText(input.statement)}`);
}

function nextUpdatedAt(currentUpdatedAt: number, proposedAt: number): number {
  return Math.max(proposedAt, currentUpdatedAt + 1);
}

function isValidMemoryUnitType(value: unknown): value is MemoryUnit["type"] {
  return value === "fact" || value === "decision" || value === "constraint" || value === "risk";
}

function parseJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const out: T[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      continue;
    }
  }
  return out;
}

function defaultState(): MemoryStoreState {
  return {
    schemaVersion: MEMORY_STATE_SCHEMA_VERSION,
    lastProjectedAt: null,
  };
}

export interface MemoryStoreOptions {
  rootDir: string;
  workingFile: string;
}

export class MemoryStore {
  private readonly rootDir: string;
  private readonly unitsPath: string;
  private readonly statePath: string;
  private readonly workingPath: string;

  private unitsLoaded = false;
  private unitsById = new Map<string, MemoryUnit>();
  private unitIdBySessionFingerprint = new Map<string, string>();
  private workingBySession = new Map<string, WorkingMemorySnapshot>();
  private state: MemoryStoreState = defaultState();
  private incompatibleOnDisk = false;

  constructor(options: MemoryStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    ensureDir(this.rootDir);
    this.unitsPath = join(this.rootDir, "units.jsonl");
    this.statePath = join(this.rootDir, "state.json");
    this.workingPath = join(this.rootDir, options.workingFile);
    this.ensureStateLoaded();
    if (this.incompatibleOnDisk) {
      this.resetOnDisk();
    }
  }

  hasUnits(sessionId: string): boolean {
    this.ensureUnitsLoaded();
    for (const unit of this.unitsById.values()) {
      if (unit.sessionId === sessionId) return true;
    }
    return false;
  }

  upsertUnit(
    input: MemoryUnitCandidate,
    observedAt = Date.now(),
  ): { unit: MemoryUnit; created: boolean } {
    this.ensureUnitsLoaded();

    const topic = input.topic.trim();
    const statement = input.statement.trim();
    if (!topic || !statement) {
      throw new Error("Memory unit topic/statement cannot be empty.");
    }

    const fingerprint = fingerprintForUnit({
      type: input.type,
      topic,
      statement,
    });
    const key = `${input.sessionId}:${fingerprint}`;
    const existingId = this.unitIdBySessionFingerprint.get(key);
    const existing = existingId ? this.unitsById.get(existingId) : undefined;

    if (existing) {
      const updatedAt = nextUpdatedAt(existing.updatedAt, observedAt);
      const nextStatus =
        existing.status === "resolved" || input.status === "resolved" ? "resolved" : "active";
      const merged: MemoryUnit = {
        ...existing,
        status: nextStatus,
        confidence: Math.max(existing.confidence, normalizeConfidence(input.confidence)),
        sourceRefs: mergeSourceRefs(existing.sourceRefs, input.sourceRefs),
        metadata:
          input.metadata && existing.metadata
            ? { ...existing.metadata, ...input.metadata }
            : (input.metadata ?? existing.metadata),
        updatedAt,
        lastSeenAt: updatedAt,
        resolvedAt: nextStatus === "resolved" ? (existing.resolvedAt ?? updatedAt) : undefined,
      };
      this.unitsById.set(merged.id, merged);
      this.appendJsonLine(this.unitsPath, merged);
      return { unit: merged, created: false };
    }

    const timestamp = observedAt;
    const created: MemoryUnit = {
      id: nowId("memu"),
      sessionId: input.sessionId,
      type: input.type,
      status: input.status,
      topic,
      statement,
      confidence: normalizeConfidence(input.confidence),
      fingerprint,
      sourceRefs: mergeSourceRefs([], input.sourceRefs),
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      resolvedAt: input.status === "resolved" ? timestamp : undefined,
    };
    this.unitsById.set(created.id, created);
    this.unitIdBySessionFingerprint.set(key, created.id);
    this.appendJsonLine(this.unitsPath, created);
    return { unit: created, created: true };
  }

  resolveUnits(directive: MemoryUnitResolveDirective): number {
    this.ensureUnitsLoaded();
    let resolved = 0;

    for (const unit of this.unitsById.values()) {
      if (unit.sessionId !== directive.sessionId) continue;
      if (unit.status !== "active") continue;

      const matched = (() => {
        if (directive.sourceType === "truth_fact") {
          return unit.metadata?.truthFactId === directive.sourceId;
        }
        if (directive.sourceType === "task_blocker") {
          return unit.metadata?.taskBlockerId === directive.sourceId;
        }
        return false;
      })();

      if (!matched) continue;

      const resolvedAt = nextUpdatedAt(unit.updatedAt, directive.resolvedAt);
      const updated: MemoryUnit = {
        ...unit,
        status: "resolved",
        updatedAt: resolvedAt,
        lastSeenAt: resolvedAt,
        resolvedAt,
      };
      this.unitsById.set(updated.id, updated);
      this.appendJsonLine(this.unitsPath, updated);
      resolved += 1;
    }

    return resolved;
  }

  ingestExtraction(
    input: MemoryExtractionResult,
    observedAt = Date.now(),
  ): {
    upsertedUnits: number;
    resolvedUnits: number;
  } {
    let upsertedUnits = 0;
    let resolvedUnits = 0;

    for (const candidate of input.upserts) {
      this.upsertUnit(candidate, observedAt);
      upsertedUnits += 1;
    }
    for (const directive of input.resolves) {
      resolvedUnits += this.resolveUnits(directive);
    }

    return {
      upsertedUnits,
      resolvedUnits,
    };
  }

  listUnits(sessionId?: string): MemoryUnit[] {
    this.ensureUnitsLoaded();
    const units = [...this.unitsById.values()];
    const filtered = sessionId ? units.filter((unit) => unit.sessionId === sessionId) : units;
    return filtered.toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  getWorkingSnapshot(sessionId: string): WorkingMemorySnapshot | undefined {
    return this.workingBySession.get(sessionId);
  }

  setWorkingSnapshot(snapshot: WorkingMemorySnapshot): void {
    this.workingBySession.set(snapshot.sessionId, snapshot);
    this.state = {
      ...this.state,
      lastProjectedAt: snapshot.generatedAt,
    };
    this.writeState();
    writeFileAtomic(this.workingPath, `${snapshot.content}\n`);
  }

  clearWorkingSnapshot(sessionId: string): void {
    this.workingBySession.delete(sessionId);
  }

  private ensureUnitsLoaded(): void {
    if (this.unitsLoaded) return;
    const rows = parseJsonLines<unknown>(this.unitsPath);
    this.unitsById.clear();
    this.unitIdBySessionFingerprint.clear();

    let invalid = false;
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.sessionId !== "string") continue;
      if (!isValidMemoryUnitType(record.type)) {
        invalid = true;
        break;
      }
      if (typeof record.fingerprint !== "string") continue;
      const unit = record as unknown as MemoryUnit;
      const existing = this.unitsById.get(unit.id);
      if (!existing || unit.updatedAt >= existing.updatedAt) {
        this.unitsById.set(unit.id, unit);
      }
    }

    if (invalid) {
      this.unitsLoaded = true;
      this.incompatibleOnDisk = true;
      this.resetOnDisk();
      return;
    }

    for (const unit of this.unitsById.values()) {
      this.unitIdBySessionFingerprint.set(`${unit.sessionId}:${unit.fingerprint}`, unit.id);
    }

    this.unitsLoaded = true;
  }

  private ensureStateLoaded(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<MemoryStoreState>;
      if (
        typeof raw.schemaVersion === "number" &&
        raw.schemaVersion === MEMORY_STATE_SCHEMA_VERSION &&
        (raw.lastProjectedAt === null ||
          (typeof raw.lastProjectedAt === "number" && Number.isFinite(raw.lastProjectedAt)))
      ) {
        this.state = {
          schemaVersion: raw.schemaVersion,
          lastProjectedAt: raw.lastProjectedAt,
        };
        this.incompatibleOnDisk = false;
      } else {
        this.incompatibleOnDisk = true;
      }
    } catch {
      this.state = defaultState();
      this.incompatibleOnDisk = true;
    }
  }

  private resetOnDisk(): void {
    // No backwards compatibility: treat on-disk state as disposable projection.
    // If schema changes, discard the old projection rather than attempting migration.
    try {
      writeFileAtomic(this.unitsPath, "");
    } catch {
      // ignore
    }
    try {
      writeFileAtomic(this.workingPath, "");
    } catch {
      // ignore
    }
    this.unitsLoaded = true;
    this.unitsById.clear();
    this.unitIdBySessionFingerprint.clear();
    this.workingBySession.clear();
    this.state = defaultState();
    this.writeState();
    this.incompatibleOnDisk = false;
  }

  private appendJsonLine(path: string, value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    let current = "";
    if (existsSync(path)) {
      current = readFileSync(path, "utf8");
    }
    writeFileAtomic(path, `${current}${line}`);
  }

  private writeState(): void {
    writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
