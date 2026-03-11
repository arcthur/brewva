import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import type {
  ProjectionExtractionResult,
  ProjectionStoreState,
  ProjectionUnit,
  ProjectionUnitCandidate,
  ProjectionUnitResolveDirective,
  WorkingProjectionSnapshot,
} from "./types.js";
import { mergeSourceRefs, normalizeText } from "./utils.js";

const PROJECTION_STATE_SCHEMA_VERSION = 5;
const WORKING_SNAPSHOTS_DIR = "sessions";
const ENCODED_SESSION_PREFIX = "sess_";

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function fingerprintForUnit(input: { projectionKey: string }): string {
  return sha256(normalizeText(input.projectionKey));
}

function nextUpdatedAt(currentUpdatedAt: number, proposedAt: number): number {
  return Math.max(proposedAt, currentUpdatedAt + 1);
}

function isValidProjectionUnitStatus(value: unknown): value is ProjectionUnit["status"] {
  return value === "active" || value === "resolved";
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

function encodeSessionIdForFileName(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function defaultState(): ProjectionStoreState {
  return {
    schemaVersion: PROJECTION_STATE_SCHEMA_VERSION,
    lastProjectedAt: null,
  };
}

export interface ProjectionStoreOptions {
  rootDir: string;
  workingFile: string;
}

export class ProjectionStore {
  private readonly rootDir: string;
  private readonly unitsPath: string;
  private readonly statePath: string;
  private readonly workingFile: string;
  private readonly workingLegacyPath: string;
  private readonly workingSessionsRoot: string;

  private unitsLoaded = false;
  private unitsById = new Map<string, ProjectionUnit>();
  private unitIdBySessionFingerprint = new Map<string, string>();
  private workingBySession = new Map<string, WorkingProjectionSnapshot>();
  private state: ProjectionStoreState = defaultState();
  private incompatibleOnDisk = false;

  constructor(options: ProjectionStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    ensureDir(this.rootDir);
    this.unitsPath = join(this.rootDir, "units.jsonl");
    this.statePath = join(this.rootDir, "state.json");
    this.workingFile = options.workingFile;
    this.workingLegacyPath = join(this.rootDir, options.workingFile);
    this.workingSessionsRoot = join(this.rootDir, WORKING_SNAPSHOTS_DIR);
    this.ensureStateLoaded();
    if (this.incompatibleOnDisk) {
      this.resetOnDisk();
      return;
    }
    this.removeLegacyWorkingSnapshotFile();
  }

  hasUnits(sessionId: string): boolean {
    this.ensureUnitsLoaded();
    for (const unit of this.unitsById.values()) {
      if (unit.sessionId === sessionId) return true;
    }
    return false;
  }

  upsertUnit(
    input: ProjectionUnitCandidate,
    observedAt = Date.now(),
  ): { unit: ProjectionUnit; created: boolean } {
    this.ensureUnitsLoaded();

    const projectionKey = input.projectionKey.trim();
    const label = input.label.trim();
    const statement = input.statement.trim();
    if (!projectionKey || !label || !statement) {
      throw new Error("Projection unit projectionKey/label/statement cannot be empty.");
    }

    const fingerprint = fingerprintForUnit({
      projectionKey,
    });
    const key = `${input.sessionId}:${fingerprint}`;
    const existingId = this.unitIdBySessionFingerprint.get(key);
    const existing = existingId ? this.unitsById.get(existingId) : undefined;

    if (existing) {
      const updatedAt = nextUpdatedAt(existing.updatedAt, observedAt);
      const nextStatus = input.status;
      const merged: ProjectionUnit = {
        ...existing,
        projectionKey,
        label,
        status: nextStatus,
        statement,
        sourceRefs: mergeSourceRefs(existing.sourceRefs, input.sourceRefs),
        metadata:
          input.metadata && existing.metadata
            ? { ...existing.metadata, ...input.metadata }
            : (input.metadata ?? existing.metadata),
        updatedAt,
        lastSeenAt: updatedAt,
        resolvedAt: nextStatus === "resolved" ? updatedAt : undefined,
      };
      this.unitsById.set(merged.id, merged);
      this.appendJsonLine(this.unitsPath, merged);
      return { unit: merged, created: false };
    }

    const timestamp = observedAt;
    const created: ProjectionUnit = {
      id: nowId("prju"),
      sessionId: input.sessionId,
      status: input.status,
      projectionKey,
      label,
      statement,
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

  resolveUnits(directive: ProjectionUnitResolveDirective): number {
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
        if (directive.sourceType === "projection_group") {
          const keep = new Set(directive.keepProjectionKeys);
          return (
            unit.metadata?.projectionGroup === directive.groupKey && !keep.has(unit.projectionKey)
          );
        }
        return false;
      })();

      if (!matched) continue;

      const resolvedAt = nextUpdatedAt(unit.updatedAt, directive.resolvedAt);
      const updated: ProjectionUnit = {
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
    input: ProjectionExtractionResult,
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

  listUnits(sessionId?: string): ProjectionUnit[] {
    this.ensureUnitsLoaded();
    const units = [...this.unitsById.values()];
    const filtered = sessionId ? units.filter((unit) => unit.sessionId === sessionId) : units;
    return filtered.toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.projectionKey.localeCompare(right.projectionKey),
    );
  }

  getWorkingSnapshot(sessionId: string): WorkingProjectionSnapshot | undefined {
    return this.workingBySession.get(sessionId);
  }

  setWorkingSnapshot(snapshot: WorkingProjectionSnapshot): void {
    this.workingBySession.set(snapshot.sessionId, snapshot);
    this.state = {
      ...this.state,
      lastProjectedAt: snapshot.generatedAt,
    };
    this.writeState();
    writeFileAtomic(this.workingPathForSession(snapshot.sessionId), `${snapshot.content}\n`);
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
      if (
        !isValidProjectionUnitStatus(record.status) ||
        typeof record.projectionKey !== "string" ||
        typeof record.label !== "string" ||
        typeof record.statement !== "string" ||
        typeof record.fingerprint !== "string"
      ) {
        invalid = true;
        break;
      }
      const unit = record as unknown as ProjectionUnit;
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
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<ProjectionStoreState>;
      if (
        typeof raw.schemaVersion === "number" &&
        raw.schemaVersion === PROJECTION_STATE_SCHEMA_VERSION &&
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
    this.clearWorkingSnapshotsOnDisk();
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
    // Projection units are an append-only recovery log. Keep writes O(1) on the
    // event hot path and rely on replay/latest-write-wins to rebuild state.
    appendFileSync(path, line, "utf8");
  }

  private writeState(): void {
    writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private workingPathForSession(sessionId: string): string {
    return join(
      this.workingSessionsRoot,
      `${ENCODED_SESSION_PREFIX}${encodeSessionIdForFileName(sessionId)}`,
      this.workingFile,
    );
  }

  private clearWorkingSnapshotsOnDisk(): void {
    try {
      rmSync(this.workingSessionsRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
    this.removeLegacyWorkingSnapshotFile();
  }

  private removeLegacyWorkingSnapshotFile(): void {
    if (!existsSync(this.workingLegacyPath)) return;
    try {
      const stat = statSync(this.workingLegacyPath);
      if (!stat.isFile()) return;
      rmSync(this.workingLegacyPath, { force: true });
    } catch {
      // ignore
    }
  }
}
