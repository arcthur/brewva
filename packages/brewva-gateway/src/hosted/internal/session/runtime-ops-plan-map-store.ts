import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type AppendOnlyClassification,
  appendFileDurable,
  scanAppendOnly,
} from "@brewva/brewva-std/node/fs";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { PLAN_MAP_EVENT_TYPES, type PlanMapEventType } from "@brewva/brewva-vocabulary/plan-map";

const PLAN_MAP_DIR = ".brewva/planning";
const PLAN_MAP_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PLAN_MAP_EVENT_TYPES);

export interface PlanMapAppendContext {
  readonly sessionId: string;
  readonly now: number;
}

export interface PlanMapSidecarStore {
  /** The map's append-only log path, exposed for inspection and tests. */
  readonly filePath: string;
  /** Append one plan receipt, fsync-durable. Returns the stored record. */
  append(
    type: PlanMapEventType,
    payload: Record<string, unknown>,
    context: PlanMapAppendContext,
  ): BrewvaEventRecord;
  /** Re-read the full receipt stream from disk (multi-writer: no cached view). */
  load(): readonly BrewvaEventRecord[];
}

export interface PlanMapSidecarStoreOptions {
  readonly workspaceRoot: string;
  readonly mapId: string;
  readonly dir?: string;
}

function isPlanEventType(value: unknown): value is PlanMapEventType {
  return typeof value === "string" && PLAN_MAP_EVENT_TYPE_SET.has(value);
}

function classifyPlanMapLine(line: string): AppendOnlyClassification<BrewvaEventRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, issueClass: "invalid_json", tag: "plan-map" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, issueClass: "non_object", tag: "plan-map" };
  }
  const record = parsed as Record<string, unknown>;
  if (!isPlanEventType(record.type)) {
    return { ok: false, issueClass: "unknown_type", tag: "plan-map" };
  }
  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp)
  ) {
    return { ok: false, issueClass: "malformed_envelope", tag: "plan-map" };
  }
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return { ok: false, issueClass: "malformed_payload", tag: "plan-map" };
  }
  return { ok: true, value: record as unknown as BrewvaEventRecord };
}

/**
 * An effort-scoped, multi-writer durable log for one planning map. Unlike the
 * session-scoped steering inbox — single-writer, its in-memory map authoritative —
 * this store is written by any session that works the map, so it keeps NO
 * authoritative cache: every `load()` re-reads the file, so a concurrent session's
 * appends are observed.
 *
 * Concurrency safety rests on two properties: appends are atomic `O_APPEND`
 * fsync-durable writes (`appendFileDurable`), and reads are strictly read-only
 * (`scanAppendOnly` never truncates). The store never mutates the file on load, so
 * a read can never destroy a concurrent durable append — the hazard the
 * truncate-repairing `loadAppendOnly` would introduce for a multi-writer log. A
 * torn tail (power loss only — a small record is a single atomic append that a
 * process crash keeps in the page cache) or a malformed/foreign line is skipped on
 * read, never wedging a rebuild and never mutating the file. Claim exclusion and
 * settle-once are the fold's job (first write in file order wins); the store
 * guarantees durable, ordered bytes under lock-free concurrent reads.
 */
export function createPlanMapSidecarStore(
  options: PlanMapSidecarStoreOptions,
): PlanMapSidecarStore {
  const mapId = options.mapId.trim();
  if (!mapId) {
    throw new Error("createPlanMapSidecarStore: mapId must be a non-empty string");
  }
  const dir = options.dir ?? PLAN_MAP_DIR;
  const filePath = resolve(
    resolve(options.workspaceRoot, dir),
    `${encodeURIComponent(mapId)}.jsonl`,
  );
  let sequence = 0;

  function ensureDir(): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  return Object.freeze({
    filePath,
    append(
      type: PlanMapEventType,
      payload: Record<string, unknown>,
      context: PlanMapAppendContext,
    ): BrewvaEventRecord {
      if (!Number.isFinite(context.now)) {
        throw new Error("plan-map append: `now` must be a finite number");
      }
      sequence += 1;
      // The store stamps `mapId` (this log is per-map, so every receipt belongs to
      // it — the emit path cannot forget it, closing the fold's silent-drop trap)
      // and `now` (into the payload as well as the envelope, so the pure fold, which
      // prefers `payload.now`, is deterministic against the same log). The id carries
      // the authoring `sessionId` so two sessions appending in the same millisecond
      // never collide on a receipt id.
      const record: BrewvaEventRecord = Object.freeze({
        id: `plan:${encodeURIComponent(mapId)}:${encodeURIComponent(context.sessionId)}:${context.now}:${sequence}`,
        sessionId: context.sessionId,
        type,
        payload: Object.freeze({ ...payload, mapId, now: context.now }),
        timestamp: context.now,
      });
      ensureDir();
      appendFileDurable(filePath, `${JSON.stringify(record)}\n`);
      return record;
    },
    load(): readonly BrewvaEventRecord[] {
      const records: BrewvaEventRecord[] = [];
      scanAppendOnly(filePath, (line) => {
        const classification = classifyPlanMapLine(line.text);
        if (classification.ok) {
          records.push(classification.value);
        }
        // A malformed, foreign, or torn line is skipped — never mutating the file.
      });
      return records;
    },
  });
}
