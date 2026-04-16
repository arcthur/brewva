import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ScheduleIntentProjectionRecord,
  ScheduleProjectionSnapshot,
} from "../contracts/index.js";
import { asBrewvaIntentId, asBrewvaSessionId } from "../contracts/index.js";
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

function readProjectionRecord(value: unknown): ScheduleIntentProjectionRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.intentId !== "string" || value.intentId.trim().length === 0) return null;
  if (typeof value.parentSessionId !== "string" || value.parentSessionId.trim().length === 0)
    return null;
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) return null;
  if (value.continuityMode !== "inherit" && value.continuityMode !== "fresh") return null;
  if (value.timeZone !== undefined && typeof value.timeZone !== "string") return null;
  if (typeof value.maxRuns !== "number" || !Number.isFinite(value.maxRuns) || value.maxRuns <= 0) {
    return null;
  }
  if (
    typeof value.runCount !== "number" ||
    !Number.isFinite(value.runCount) ||
    value.runCount < 0
  ) {
    return null;
  }
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt <= 0
  ) {
    return null;
  }
  if (
    typeof value.eventOffset !== "number" ||
    !Number.isFinite(value.eventOffset) ||
    value.eventOffset < 0
  ) {
    return null;
  }
  if (
    value.status !== "active" &&
    value.status !== "cancelled" &&
    value.status !== "converged" &&
    value.status !== "error"
  ) {
    return null;
  }
  return {
    intentId: asBrewvaIntentId(value.intentId),
    parentSessionId: asBrewvaSessionId(value.parentSessionId),
    reason: value.reason,
    goalRef: typeof value.goalRef === "string" ? value.goalRef : undefined,
    continuityMode: value.continuityMode,
    cron: typeof value.cron === "string" ? value.cron : undefined,
    timeZone: typeof value.timeZone === "string" ? value.timeZone : undefined,
    runAt: typeof value.runAt === "number" ? value.runAt : undefined,
    maxRuns: value.maxRuns,
    runCount: value.runCount,
    nextRunAt: typeof value.nextRunAt === "number" ? value.nextRunAt : undefined,
    status: value.status,
    convergenceCondition:
      value.convergenceCondition as ScheduleIntentProjectionRecord["convergenceCondition"],
    consecutiveErrors:
      typeof value.consecutiveErrors === "number" && Number.isFinite(value.consecutiveErrors)
        ? value.consecutiveErrors
        : 0,
    leaseUntilMs: typeof value.leaseUntilMs === "number" ? value.leaseUntilMs : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    lastEvaluationSessionId:
      typeof value.lastEvaluationSessionId === "string" ? value.lastEvaluationSessionId : undefined,
    updatedAt: value.updatedAt,
    eventOffset: value.eventOffset,
  };
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
  const record = readProjectionRecord(value.record);
  if (!record) return null;
  return {
    schema: "brewva.schedule.projection.v1",
    kind: "intent",
    record,
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
