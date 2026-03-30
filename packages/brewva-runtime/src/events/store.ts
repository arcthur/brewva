import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  BrewvaConfig,
  BrewvaEventQuery,
  BrewvaEventRecord,
  IntegrityIssue,
} from "../contracts/index.js";
import { redactUnknown } from "../security/redact.js";
import {
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  type TapeAnchorPayload,
  type TapeCheckpointPayload,
} from "../tape/events.js";
import { ensureDir, ensureDirForFile } from "../utils/fs.js";
import { normalizeJsonRecord } from "../utils/json.js";

type EventAppendInput = {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: Record<string, unknown>;
  timestamp?: number;
};

const ENCODED_SESSION_PREFIX = "sess_";

function encodeSessionIdForFileName(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function decodeSessionIdFromFileName(encoded: string): string | null {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}

interface EventFileCache {
  readonly rows: BrewvaEventRecord[];
  byteOffset: number;
  trailingFragment: string;
  timestampsMonotonic: boolean;
  lastTimestamp: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreezeJson(entry);
    }
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      deepFreezeJson(entry);
    }
    return Object.freeze(value);
  }
  return value;
}

function freezeEventRecord(row: BrewvaEventRecord): BrewvaEventRecord {
  const payload = row.payload ? deepFreezeJson(row.payload) : undefined;
  return Object.freeze({
    ...row,
    payload,
  });
}

function parseEventRecord(line: string): BrewvaEventRecord | null {
  try {
    const value = JSON.parse(line) as BrewvaEventRecord;
    if (
      value &&
      typeof value.id === "string" &&
      typeof value.sessionId === "string" &&
      typeof value.type === "string" &&
      typeof value.timestamp === "number" &&
      Number.isFinite(value.timestamp) &&
      (value.turn === undefined ||
        (typeof value.turn === "number" && Number.isFinite(value.turn))) &&
      (value.payload === undefined || isRecord(value.payload))
    ) {
      return freezeEventRecord(value);
    }
  } catch {
    return null;
  }
  return null;
}

export class BrewvaEventStore {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly fileHasContent = new Map<string, boolean>();
  private readonly eventCacheByFilePath = new Map<string, EventFileCache>();
  private readonly integrityIssuesByFilePath = new Map<string, IntegrityIssue[]>();

  constructor(config: BrewvaConfig["infrastructure"]["events"], cwd: string) {
    this.enabled = config.enabled;
    this.dir = resolve(cwd, config.dir);
    if (this.enabled) {
      ensureDir(this.dir);
    }
  }

  append(input: EventAppendInput): BrewvaEventRecord | undefined {
    if (!this.enabled) return undefined;

    const timestamp = input.timestamp ?? Date.now();
    const id = `evt_${timestamp}_${randomUUID()}`;
    const row: BrewvaEventRecord = {
      id,
      sessionId: input.sessionId,
      type: input.type,
      timestamp,
      turn: input.turn,
      payload: normalizeJsonRecord(
        input.payload ? (redactUnknown(input.payload) as Record<string, unknown>) : undefined,
      ),
    };
    const frozenRow = freezeEventRecord(row);

    const filePath = this.filePathForSession(frozenRow.sessionId);
    if (!existsSync(filePath)) {
      this.fileHasContent.set(filePath, false);
      this.eventCacheByFilePath.delete(filePath);
    }
    ensureDirForFile(filePath);
    const prefix = this.hasContent(filePath) ? "\n" : "";
    const serialized = JSON.stringify(frozenRow);
    const appended = `${prefix}${serialized}`;
    writeFileSync(filePath, appended, { flag: "a" });
    this.fileHasContent.set(filePath, true);
    this.trackAppendedRow(filePath, frozenRow, appended);
    return frozenRow;
  }

  appendAnchor(input: {
    sessionId: string;
    payload: TapeAnchorPayload;
    turn?: number;
    timestamp?: number;
  }): BrewvaEventRecord | undefined {
    return this.append({
      sessionId: input.sessionId,
      type: TAPE_ANCHOR_EVENT_TYPE,
      turn: input.turn,
      payload: input.payload as unknown as Record<string, unknown>,
      timestamp: input.timestamp,
    });
  }

  appendCheckpoint(input: {
    sessionId: string;
    payload: TapeCheckpointPayload;
    turn?: number;
    timestamp?: number;
  }): BrewvaEventRecord | undefined {
    return this.append({
      sessionId: input.sessionId,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
      turn: input.turn,
      payload: input.payload as unknown as Record<string, unknown>,
      timestamp: input.timestamp,
    });
  }

  list(sessionId: string, query: BrewvaEventQuery = {}): BrewvaEventRecord[] {
    const cache = this.getCache(sessionId);
    const rows = this.selectTimeWindow(cache, query);
    const type = typeof query.type === "string" && query.type.trim().length > 0 ? query.type : null;
    const last = this.normalizeTailCount(query.last);
    const offset = this.normalizeWindowCount(query.offset);
    const limit = this.normalizeWindowCount(query.limit);

    let matches = type ? rows.filter((row) => row.type === type) : rows.slice();

    if (last !== null) {
      matches = matches.slice(-last);
    }
    if (offset !== null && offset > 0) {
      matches = matches.slice(offset);
    }
    if (limit !== null) {
      matches = matches.slice(0, limit);
    }

    return matches;
  }

  listAnchors(sessionId: string, query: Omit<BrewvaEventQuery, "type"> = {}): BrewvaEventRecord[] {
    return this.list(sessionId, {
      ...query,
      type: TAPE_ANCHOR_EVENT_TYPE,
    });
  }

  listCheckpoints(
    sessionId: string,
    query: Omit<BrewvaEventQuery, "type"> = {},
  ): BrewvaEventRecord[] {
    return this.list(sessionId, {
      ...query,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
  }

  latest(sessionId: string): BrewvaEventRecord | undefined {
    return this.list(sessionId, { last: 1 })[0];
  }

  clearSessionCache(sessionId: string): void {
    const filePath = this.filePathForSession(sessionId);
    this.fileHasContent.delete(filePath);
    this.eventCacheByFilePath.delete(filePath);
    this.integrityIssuesByFilePath.delete(filePath);
  }

  getIntegrityIssues(sessionId: string): IntegrityIssue[] {
    const filePath = this.filePathForSession(sessionId);
    if (this.enabled) {
      this.syncCacheForFile(filePath);
    }
    return (this.integrityIssuesByFilePath.get(filePath) ?? []).map((issue) =>
      Object.assign({}, issue),
    );
  }

  listSessionIds(): string[] {
    if (!this.enabled) return [];
    if (!existsSync(this.dir)) return [];

    const mtimeBySessionId = new Map<string, number>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = resolve(this.dir, entry.name);
      try {
        const stat = statSync(filePath);
        if (stat.size <= 0) continue;
        const stem = entry.name.slice(0, -".jsonl".length);
        if (!stem.startsWith(ENCODED_SESSION_PREFIX)) continue;

        const decoded = decodeSessionIdFromFileName(stem.slice(ENCODED_SESSION_PREFIX.length));
        if (!decoded) continue;

        const previous = mtimeBySessionId.get(decoded) ?? 0;
        mtimeBySessionId.set(decoded, Math.max(previous, stat.mtimeMs));
      } catch {
        continue;
      }
    }

    return [...mtimeBySessionId.entries()]
      .toSorted((left, right) => right[1] - left[1])
      .map(([sessionId]) => sessionId);
  }

  private getCache(sessionId: string): EventFileCache {
    if (!this.enabled) {
      return {
        rows: [],
        byteOffset: 0,
        trailingFragment: "",
        timestampsMonotonic: true,
        lastTimestamp: null,
      };
    }
    const filePath = this.filePathForSession(sessionId);
    return this.syncCacheForFile(filePath);
  }

  private filePathForSession(sessionId: string): string {
    const encoded = encodeSessionIdForFileName(sessionId);
    return resolve(this.dir, `${ENCODED_SESSION_PREFIX}${encoded}.jsonl`);
  }

  private syncCacheForFile(filePath: string): EventFileCache {
    if (!existsSync(filePath)) {
      this.integrityIssuesByFilePath.delete(filePath);
      const empty: EventFileCache = {
        rows: [],
        byteOffset: 0,
        trailingFragment: "",
        timestampsMonotonic: true,
        lastTimestamp: null,
      };
      this.eventCacheByFilePath.set(filePath, empty);
      return empty;
    }

    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      this.integrityIssuesByFilePath.set(filePath, [
        {
          domain: "event_tape",
          severity: "degraded",
          sessionId: this.sessionIdForFilePath(filePath),
          eventId: `integrity:${filePath}`,
          eventType: "event_store_integrity",
          index: -1,
          reason: "event_store_stat_failed",
        },
      ]);
      const empty: EventFileCache = {
        rows: [],
        byteOffset: 0,
        trailingFragment: "",
        timestampsMonotonic: true,
        lastTimestamp: null,
      };
      this.eventCacheByFilePath.set(filePath, empty);
      return empty;
    }

    const cached = this.eventCacheByFilePath.get(filePath);
    if (!cached || size < cached.byteOffset) {
      return this.rebuildCacheFromFile(filePath, size);
    }

    if (size === cached.byteOffset) {
      return cached;
    }

    const appended = this.readTextRange(filePath, cached.byteOffset, size);
    this.consumeChunk(filePath, cached, appended);
    cached.byteOffset = size;
    return cached;
  }

  private rebuildCacheFromFile(filePath: string, size: number): EventFileCache {
    const cache: EventFileCache = {
      rows: [],
      byteOffset: size,
      trailingFragment: "",
      timestampsMonotonic: true,
      lastTimestamp: null,
    };

    if (size > 0) {
      try {
        const text = readFileSync(filePath, "utf8");
        this.integrityIssuesByFilePath.delete(filePath);
        this.consumeChunk(filePath, cache, text);
      } catch {
        this.integrityIssuesByFilePath.set(filePath, [
          {
            domain: "event_tape",
            severity: "degraded",
            sessionId: this.sessionIdForFilePath(filePath),
            eventId: `integrity:${filePath}`,
            eventType: "event_store_integrity",
            index: -1,
            reason: "event_store_read_failed",
          },
        ]);
      }
    } else {
      this.integrityIssuesByFilePath.delete(filePath);
    }

    this.eventCacheByFilePath.set(filePath, cache);
    return cache;
  }

  private readTextRange(filePath: string, fromOffset: number, toOffset: number): string {
    const length = Math.max(0, toOffset - fromOffset);
    if (length <= 0) return "";

    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      let consumed = 0;
      while (consumed < length) {
        const read = readSync(fd, buffer, consumed, length - consumed, fromOffset + consumed);
        if (read <= 0) break;
        consumed += read;
      }
      return buffer.subarray(0, consumed).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  private consumeChunk(filePath: string, cache: EventFileCache, text: string): void {
    if (!text && !cache.trailingFragment) {
      return;
    }
    const combined = `${cache.trailingFragment}${text}`;
    if (!combined) {
      cache.trailingFragment = "";
      return;
    }
    const lines = combined.split("\n");
    cache.trailingFragment = "";

    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? "";
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const parsed = parseEventRecord(trimmed);
      if (parsed) {
        this.pushRow(cache, parsed);
        continue;
      }

      // Keep only a potentially incomplete tail fragment for the next incremental read.
      if (index === lines.length - 1) {
        cache.trailingFragment = raw;
        continue;
      }
      const issues = this.integrityIssuesByFilePath.get(filePath) ?? [];
      issues.push({
        domain: "event_tape",
        severity: "degraded",
        sessionId: this.sessionIdForFilePath(filePath),
        eventId: `integrity:${cache.rows.length}`,
        eventType: "event_store_integrity",
        index: cache.rows.length,
        reason: "event_store_malformed_row",
      });
      this.integrityIssuesByFilePath.set(filePath, issues);
    }
  }

  private trackAppendedRow(filePath: string, row: BrewvaEventRecord, appended: string): void {
    const cached = this.eventCacheByFilePath.get(filePath);
    if (!cached) return;
    if (cached.trailingFragment) {
      this.eventCacheByFilePath.delete(filePath);
      return;
    }
    this.pushRow(cached, row);
    cached.byteOffset += Buffer.byteLength(appended, "utf8");
  }

  private pushRow(cache: EventFileCache, row: BrewvaEventRecord): void {
    if (cache.lastTimestamp !== null && row.timestamp < cache.lastTimestamp) {
      cache.timestampsMonotonic = false;
    }
    cache.lastTimestamp = row.timestamp;
    cache.rows.push(row);
  }

  private selectTimeWindow(cache: EventFileCache, query: BrewvaEventQuery): BrewvaEventRecord[] {
    const after = this.normalizeTimestamp(query.after);
    const before = this.normalizeTimestamp(query.before);
    if (after !== null && before !== null && after >= before) {
      return [];
    }
    if (after === null && before === null) {
      return cache.rows;
    }
    if (cache.timestampsMonotonic) {
      const startIndex = after === null ? 0 : this.findFirstTimestampAtLeast(cache.rows, after);
      const endIndex =
        before === null ? cache.rows.length : this.findFirstTimestampAtLeast(cache.rows, before);
      return cache.rows.slice(startIndex, endIndex);
    }
    return cache.rows.filter((row) => {
      if (after !== null && row.timestamp < after) return false;
      if (before !== null && row.timestamp >= before) return false;
      return true;
    });
  }

  private findFirstTimestampAtLeast(rows: readonly BrewvaEventRecord[], target: number): number {
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const row = rows[middle];
      if (!row || row.timestamp >= target) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }

  private normalizeTimestamp(value: number | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  private normalizeTailCount(value: number | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    const normalized = Math.max(0, Math.floor(value));
    return normalized > 0 ? normalized : null;
  }

  private normalizeWindowCount(value: number | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.floor(value));
  }

  private hasContent(filePath: string): boolean {
    const cached = this.fileHasContent.get(filePath);
    if (cached !== undefined) {
      return cached;
    }

    let hasData = false;
    if (existsSync(filePath)) {
      try {
        hasData = statSync(filePath).size > 0;
      } catch {
        hasData = false;
      }
    }
    this.fileHasContent.set(filePath, hasData);
    return hasData;
  }

  private sessionIdForFilePath(filePath: string): string | undefined {
    const name = filePath.split("/").pop() ?? "";
    const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
    if (!stem.startsWith(ENCODED_SESSION_PREFIX)) {
      return undefined;
    }
    return decodeSessionIdFromFileName(stem.slice(ENCODED_SESSION_PREFIX.length)) ?? undefined;
  }
}
