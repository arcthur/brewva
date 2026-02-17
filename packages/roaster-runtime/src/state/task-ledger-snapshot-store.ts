import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RoasterEventRecord, RoasterConfig, TaskState } from "../types.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { normalizeJsonRecord } from "../utils/json.js";
import {
  TASK_EVENT_TYPE,
  TASK_LEDGER_SCHEMA,
  buildCheckpointSetEvent,
  coerceTaskLedgerPayload,
  createEmptyTaskState,
  reduceTaskState,
} from "../task/ledger.js";

const COMPACT_COOLDOWN_MS = 60_000;
const COMPACT_MIN_BYTES = 64_000;
const COMPACT_MAX_BYTES = 10 * 1024 * 1024;
const COMPACT_KEEP_LAST_TASK_EVENTS = 80;
const COMPACT_MIN_TASK_EVENTS = 220;

export interface TaskLedgerSnapshot {
  version: 1;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  logOffsetBytes: number;
  state: TaskState;
}

export interface TaskLedgerCompactionResult {
  sessionId: string;
  compacted: number;
  kept: number;
  bytesBefore: number;
  bytesAfter: number;
  durationMs: number;
  checkpointEventId: string;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function isTaskLedgerSnapshot(value: unknown): value is TaskLedgerSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  if (typeof record.sessionId !== "string") return false;
  if (typeof record.createdAt !== "number") return false;
  if (typeof record.updatedAt !== "number") return false;
  if (typeof record.logOffsetBytes !== "number") return false;
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) return false;
  return true;
}

function parseEventLine(line: string): RoasterEventRecord | undefined {
  try {
    const value = JSON.parse(line) as RoasterEventRecord;
    if (!value || typeof value.id !== "string" || typeof value.type !== "string" || typeof value.sessionId !== "string") {
      return undefined;
    }
    if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function buildEventId(prefix: string, timestamp: number): string {
  return `${prefix}_${timestamp}_${Math.random().toString(36).slice(2, 10)}`;
}

function forEachParsedEvent(filePath: string, handler: (event: RoasterEventRecord) => void): void {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let carry = "";

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      const chunk = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const event = parseEventLine(trimmed);
        if (!event) continue;
        handler(event);
      }
    }

    const remaining = decoder.end();
    const tail = (carry + remaining).trim();
    if (tail.length > 0) {
      const event = parseEventLine(tail);
      if (event) {
        handler(event);
      }
    }
  } finally {
    closeSync(fd);
  }
}

function writeJsonlLine(fd: number, state: { first: boolean }, line: string): void {
  if (!state.first) {
    writeSync(fd, "\n", undefined, "utf8");
  } else {
    state.first = false;
  }
  writeSync(fd, line, undefined, "utf8");
}

function writeJsonlAtomic(filePath: string, writer: (writeLine: (line: string) => void) => void): void {
  const resolvedPath = resolve(filePath);
  const parent = dirname(resolvedPath);
  ensureDir(parent);
  const tempPath = join(
    parent,
    `.${Math.random().toString(36).slice(2, 10)}.${Date.now().toString(36)}.tmp`,
  );

  const fd = openSync(tempPath, "w");
  const state = { first: true };
  try {
    writer((line) => writeJsonlLine(fd, state, line));
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    closeSync(fd);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    renameSync(tempPath, resolvedPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

function applyTaskEventsFromOffset(input: {
  filePath: string;
  sessionId: string;
  offsetBytes: number;
  baseState: TaskState;
}): { state: TaskState; endOffsetBytes: number; changed: boolean } {
  if (!existsSync(input.filePath)) {
    return { state: input.baseState, endOffsetBytes: input.offsetBytes, changed: false };
  }

  let size = 0;
  try {
    size = statSync(input.filePath).size;
  } catch {
    return { state: input.baseState, endOffsetBytes: input.offsetBytes, changed: false };
  }

  const start = Math.max(0, Math.floor(input.offsetBytes));
  if (size <= start) {
    return { state: input.baseState, endOffsetBytes: size, changed: false };
  }

  const fd = openSync(input.filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    let position = start;
    let carry = "";
    let state = input.baseState;
    let changed = false;

    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      const chunk = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split("\n");
      carry = lines.pop() ?? "";

      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        const event = parseEventLine(trimmed);
        if (!event) continue;
        if (event.sessionId !== input.sessionId) continue;
        if (event.type !== TASK_EVENT_TYPE) continue;
        const payload = coerceTaskLedgerPayload(event.payload);
        if (!payload) continue;
        state = reduceTaskState(state, payload, event.timestamp);
        changed = true;
      }
    }

    const remaining = decoder.end();
    const tail = (carry + remaining).trim();
    if (tail.length > 0) {
      const event = parseEventLine(tail);
      if (event && event.sessionId === input.sessionId && event.type === TASK_EVENT_TYPE) {
        const payload = coerceTaskLedgerPayload(event.payload);
        if (payload) {
          state = reduceTaskState(state, payload, event.timestamp);
          changed = true;
        }
      }
    }

    return { state, endOffsetBytes: position, changed };
  } finally {
    closeSync(fd);
  }
}

export class TaskLedgerSnapshotStore {
  private readonly enabled: boolean;
  private readonly snapshotsDir: string;
  private readonly archiveDir: string;
  private readonly eventsDir: string;
  private lastCompactionAtBySession = new Map<string, number>();

  constructor(
    config: { enabled: boolean; snapshotsDir: string; eventsDir: string },
    cwd: string,
  ) {
    this.enabled = config.enabled;
    const resolvedCwd = resolve(cwd);
    this.snapshotsDir = resolve(resolvedCwd, config.snapshotsDir, "task-ledger");
    this.archiveDir = resolve(this.snapshotsDir, "archive");
    this.eventsDir = resolve(resolvedCwd, config.eventsDir);
    if (this.enabled) {
      ensureDir(this.snapshotsDir);
      ensureDir(this.archiveDir);
    }
  }

  hydrate(sessionId: string): TaskState | undefined {
    if (!this.enabled) return undefined;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    if (!existsSync(snapshotPath)) return undefined;

    let parsed: TaskLedgerSnapshot | undefined;
    try {
      parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskLedgerSnapshot;
    } catch {
      return undefined;
    }
    if (!isTaskLedgerSnapshot(parsed)) return undefined;
    if (parsed.sessionId !== sessionId) return undefined;

    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);
    if (!existsSync(eventsPath)) {
      return parsed.state;
    }

    let currentSize = 0;
    try {
      currentSize = statSync(eventsPath).size;
    } catch {
      return parsed.state;
    }

    if (currentSize < parsed.logOffsetBytes) {
      return undefined;
    }

    if (currentSize === parsed.logOffsetBytes) {
      return parsed.state;
    }

    const catchUp = applyTaskEventsFromOffset({
      filePath: eventsPath,
      sessionId,
      offsetBytes: parsed.logOffsetBytes,
      baseState: parsed.state,
    });

    if (catchUp.endOffsetBytes > parsed.logOffsetBytes) {
      const now = Date.now();
      const nextSnapshot: TaskLedgerSnapshot = {
        version: 1,
        sessionId,
        createdAt: parsed.createdAt,
        updatedAt: now,
        logOffsetBytes: catchUp.endOffsetBytes,
        state: catchUp.state,
      };
      writeFileAtomic(snapshotPath, JSON.stringify(nextSnapshot, null, 2));
    }

    return catchUp.state;
  }

  save(sessionId: string, state: TaskState): void {
    if (!this.enabled) return;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);

    let offsetBytes = 0;
    if (existsSync(eventsPath)) {
      try {
        offsetBytes = statSync(eventsPath).size;
      } catch {
        offsetBytes = 0;
      }
    }

    const now = Date.now();
    let createdAt = now;
    if (existsSync(snapshotPath)) {
      try {
        const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as TaskLedgerSnapshot;
        if (isTaskLedgerSnapshot(parsed) && parsed.sessionId === sessionId) {
          createdAt = parsed.createdAt;
        }
      } catch {
        // ignore
      }
    }

    const snapshot: TaskLedgerSnapshot = {
      version: 1,
      sessionId,
      createdAt,
      updatedAt: now,
      logOffsetBytes: offsetBytes,
      state,
    };
    writeFileAtomic(snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  maybeCompact(sessionId: string, state: TaskState): TaskLedgerCompactionResult | undefined {
    if (!this.enabled) return undefined;

    const startMs = Date.now();
    const lastCompactAt = this.lastCompactionAtBySession.get(sessionId) ?? 0;
    if (startMs - lastCompactAt < COMPACT_COOLDOWN_MS) return undefined;

    const normalizedSession = sanitizeSessionId(sessionId);
    const eventsPath = resolve(this.eventsDir, `${normalizedSession}.jsonl`);
    if (!existsSync(eventsPath)) return undefined;

    let size = 0;
    try {
      size = statSync(eventsPath).size;
    } catch {
      return undefined;
    }
    if (size < COMPACT_MIN_BYTES) return undefined;
    if (size > COMPACT_MAX_BYTES) return undefined;
    const bytesBefore = size;

    const keepLast = Math.max(1, COMPACT_KEEP_LAST_TASK_EVENTS);
    const tailTasks: RoasterEventRecord[] = [];
    let taskCount = 0;
    let compactedCount = 0;
    let lastCompactedEvent: RoasterEventRecord | undefined;
    let checkpointState = createEmptyTaskState();

    forEachParsedEvent(eventsPath, (event) => {
      if (event.type !== TASK_EVENT_TYPE) return;
      taskCount += 1;
      tailTasks.push(event);
      if (tailTasks.length <= keepLast) return;
      const compacted = tailTasks.shift();
      if (!compacted) return;
      compactedCount += 1;
      lastCompactedEvent = compacted;
      const payload = coerceTaskLedgerPayload(compacted.payload);
      if (!payload) return;
      checkpointState = reduceTaskState(checkpointState, payload, compacted.timestamp);
    });

    if (taskCount < COMPACT_MIN_TASK_EVENTS) return undefined;
    if (taskCount <= keepLast) return undefined;
    if (compactedCount <= 0) return undefined;
    if (!lastCompactedEvent) return undefined;

    const checkpointPayload = normalizeJsonRecord(buildCheckpointSetEvent(checkpointState) as unknown as Record<string, unknown>);
    if (!checkpointPayload) return undefined;

    const checkpointEvent: RoasterEventRecord = {
      id: buildEventId("evt_task_checkpoint", lastCompactedEvent.timestamp),
      sessionId,
      type: TASK_EVENT_TYPE,
      timestamp: lastCompactedEvent.timestamp,
      turn: lastCompactedEvent.turn,
      payload: checkpointPayload,
    };

    const archivePath = resolve(this.archiveDir, `${normalizedSession}.jsonl`);
    const archiveHasContent = existsSync(archivePath) && statSync(archivePath).size > 0;
    const archiveFd = openSync(archivePath, "a");
    try {
      const archiveState = { first: !archiveHasContent };
      const appendArchive = (line: string) => writeJsonlLine(archiveFd, archiveState, line);

      appendArchive(
        JSON.stringify({
          schema: "roaster.task.ledger.archive.v1",
          kind: "compacted",
          sessionId,
          createdAt: startMs,
          checkpointEventId: checkpointEvent.id,
          compacted: compactedCount,
          kept: keepLast,
          schemaVersion: TASK_LEDGER_SCHEMA,
        }),
      );

      writeJsonlAtomic(eventsPath, (writeLine) => {
        let seenTask = 0;
        forEachParsedEvent(eventsPath, (event) => {
          if (event.type === TASK_EVENT_TYPE) {
            seenTask += 1;
            if (seenTask <= compactedCount) {
              appendArchive(JSON.stringify(event));
              if (seenTask === compactedCount) {
                writeLine(JSON.stringify(checkpointEvent));
              }
              return;
            }
          }
          writeLine(JSON.stringify(event));
        });
      });
    } finally {
      closeSync(archiveFd);
    }

    this.save(sessionId, state);
    this.lastCompactionAtBySession.set(sessionId, startMs);

    let bytesAfter = bytesBefore;
    try {
      bytesAfter = statSync(eventsPath).size;
    } catch {
      bytesAfter = bytesBefore;
    }

    return {
      sessionId,
      compacted: compactedCount,
      kept: keepLast,
      bytesBefore,
      bytesAfter,
      durationMs: Math.max(0, Date.now() - startMs),
      checkpointEventId: checkpointEvent.id,
    };
  }

  remove(sessionId: string): void {
    if (!this.enabled) return;
    const normalizedSession = sanitizeSessionId(sessionId);
    const snapshotPath = resolve(this.snapshotsDir, `${normalizedSession}.json`);
    if (!existsSync(snapshotPath)) return;
    rmSync(snapshotPath, { force: true });
  }
}

export function createTaskLedgerSnapshotStore(config: RoasterConfig, cwd: string): TaskLedgerSnapshotStore {
  return new TaskLedgerSnapshotStore(
    {
      enabled: config.infrastructure.events.enabled,
      snapshotsDir: config.infrastructure.interruptRecovery.snapshotsDir,
      eventsDir: config.infrastructure.events.dir,
    },
    cwd,
  );
}
