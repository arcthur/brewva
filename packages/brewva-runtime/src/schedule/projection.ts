import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ScheduleIntentProjectionRecord,
  ScheduleProjectionSnapshot,
} from "../contracts/index.js";
import { writeFileAtomic } from "../utils/fs.js";

interface ProjectionMetaLine {
  schema: "brewva.schedule.projection.v1";
  kind: "meta";
  generatedAt: number;
  watermarkOffset: number;
}

interface ProjectionIntentLine {
  schema: "brewva.schedule.projection.v1";
  kind: "intent";
  record: ScheduleIntentProjectionRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProjectionRecord(value: unknown): value is ScheduleIntentProjectionRecord {
  if (!isRecord(value)) return false;
  if (typeof value.intentId !== "string" || value.intentId.trim().length === 0) return false;
  if (typeof value.parentSessionId !== "string" || value.parentSessionId.trim().length === 0)
    return false;
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) return false;
  if (value.continuityMode !== "inherit" && value.continuityMode !== "fresh") return false;
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") return false;
  if (typeof value.maxRuns !== "number" || !Number.isFinite(value.maxRuns) || value.maxRuns <= 0) {
    return false;
  }
  if (
    typeof value.runCount !== "number" ||
    !Number.isFinite(value.runCount) ||
    value.runCount < 0
  ) {
    return false;
  }
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt <= 0
  ) {
    return false;
  }
  if (
    typeof value.eventOffset !== "number" ||
    !Number.isFinite(value.eventOffset) ||
    value.eventOffset < 0
  ) {
    return false;
  }
  if (
    value.status !== "active" &&
    value.status !== "cancelled" &&
    value.status !== "converged" &&
    value.status !== "error"
  ) {
    return false;
  }
  return true;
}

function parseMetaLine(value: unknown): ProjectionMetaLine | null {
  if (!isRecord(value)) return null;
  if (value.schema !== "brewva.schedule.projection.v1") return null;
  if (value.kind !== "meta") return null;
  if (
    typeof value.generatedAt !== "number" ||
    !Number.isFinite(value.generatedAt) ||
    value.generatedAt <= 0
  ) {
    return null;
  }
  if (
    typeof value.watermarkOffset !== "number" ||
    !Number.isFinite(value.watermarkOffset) ||
    value.watermarkOffset < 0
  ) {
    return null;
  }
  return {
    schema: "brewva.schedule.projection.v1",
    kind: "meta",
    generatedAt: value.generatedAt,
    watermarkOffset: value.watermarkOffset,
  };
}

function parseIntentLine(value: unknown): ProjectionIntentLine | null {
  if (!isRecord(value)) return null;
  if (value.schema !== "brewva.schedule.projection.v1") return null;
  if (value.kind !== "intent") return null;
  if (!isProjectionRecord(value.record)) return null;
  return {
    schema: "brewva.schedule.projection.v1",
    kind: "intent",
    record: value.record,
  };
}

export class ScheduleProjectionStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  get filePath(): string {
    return this.path;
  }

  load(): ScheduleProjectionSnapshot | null {
    if (!existsSync(this.path)) return null;

    const lines = readFileSync(this.path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) return null;
    let meta: ProjectionMetaLine | null = null;
    const records: ScheduleIntentProjectionRecord[] = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const maybeMeta = parseMetaLine(parsed);
      if (maybeMeta) {
        meta = maybeMeta;
        continue;
      }
      const maybeIntent = parseIntentLine(parsed);
      if (maybeIntent) {
        records.push(maybeIntent.record);
      }
    }

    if (!meta) return null;
    return {
      schema: "brewva.schedule.projection.v1",
      generatedAt: meta.generatedAt,
      watermarkOffset: meta.watermarkOffset,
      intents: records.toSorted((left, right) => left.intentId.localeCompare(right.intentId)),
    };
  }

  save(snapshot: ScheduleProjectionSnapshot): void {
    const lines: string[] = [];
    const meta: ProjectionMetaLine = {
      schema: "brewva.schedule.projection.v1",
      kind: "meta",
      generatedAt: snapshot.generatedAt,
      watermarkOffset: snapshot.watermarkOffset,
    };
    lines.push(JSON.stringify(meta));
    for (const record of snapshot.intents) {
      const row: ProjectionIntentLine = {
        schema: "brewva.schedule.projection.v1",
        kind: "intent",
        record,
      };
      lines.push(JSON.stringify(row));
    }
    writeFileAtomic(this.path, `${lines.join("\n")}\n`);
  }
}
