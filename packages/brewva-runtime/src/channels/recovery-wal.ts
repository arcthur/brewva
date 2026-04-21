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
  BrewvaWalId,
  BrewvaConfig,
  IntegrityIssue,
  RecoveryWalIngressWatermarkRecord,
  RecoveryWalRecord,
  RecoveryWalSource,
  RecoveryWalStatus,
} from "../contracts/index.js";
import { asBrewvaSessionId, asBrewvaWalId } from "../contracts/index.js";
import { ensureDir, ensureDirForFile, writeFileAtomic } from "../utils/fs.js";
import { assertTurnEnvelope, type TurnEnvelope } from "./turn.js";

export interface RecoveryWalStoreOptions {
  workspaceRoot: string;
  config: BrewvaConfig["infrastructure"]["recoveryWal"];
  scope: string;
  now?: () => number;
  recordEvent?: (input: { sessionId: string; type: string; payload?: object }) => void;
}

export interface RecoveryWalAppendPendingOptions {
  ttlMs?: number;
  dedupeKey?: string;
}

export interface RecoveryWalCompactResult {
  scope: string;
  filePath: string;
  scanned: number;
  retained: number;
  dropped: number;
}

interface RecoveryWalFileCache {
  readonly rowsByWalId: Map<BrewvaWalId, RecoveryWalRecord>;
  readonly ingressWatermarksByKey: Map<string, RecoveryWalIngressWatermarkRecord>;
  byteOffset: number;
  trailingFragment: string;
}

const TERMINAL_STATUSES = new Set<RecoveryWalStatus>(["done", "failed", "expired"]);
const RECOVERABLE_STATUSES = new Set<RecoveryWalStatus>(["pending", "inflight"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRecoveryWalStatus(value: unknown): value is RecoveryWalStatus {
  return (
    value === "pending" ||
    value === "inflight" ||
    value === "done" ||
    value === "failed" ||
    value === "expired"
  );
}

function isRecoveryWalSource(value: unknown): value is RecoveryWalSource {
  return (
    value === "channel" ||
    value === "schedule" ||
    value === "gateway" ||
    value === "heartbeat" ||
    value === "tool"
  );
}

function parseRecoveryWalRecord(line: string): RecoveryWalRecord | null {
  let value: unknown;
  let envelope: TurnEnvelope;
  try {
    value = JSON.parse(line);
    if (!isRecord(value)) return null;
    envelope = assertTurnEnvelope(value.envelope);
  } catch {
    return null;
  }
  if (value.schema !== "brewva.recovery-wal.v1") return null;
  if (typeof value.walId !== "string" || !value.walId.trim()) return null;
  if (typeof value.turnId !== "string" || !value.turnId.trim()) return null;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return null;
  if (typeof value.channel !== "string" || !value.channel.trim()) return null;
  if (typeof value.conversationId !== "string" || !value.conversationId.trim()) return null;
  if (!isRecoveryWalStatus(value.status)) return null;
  if (
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt <= 0
  )
    return null;
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt <= 0
  )
    return null;
  if (typeof value.attempts !== "number" || !Number.isFinite(value.attempts) || value.attempts < 0)
    return null;
  if (!isRecoveryWalSource(value.source)) return null;
  if (value.error !== undefined && typeof value.error !== "string") return null;
  if (
    value.ttlMs !== undefined &&
    (typeof value.ttlMs !== "number" || !Number.isFinite(value.ttlMs) || value.ttlMs <= 0)
  ) {
    return null;
  }
  if (value.dedupeKey !== undefined && typeof value.dedupeKey !== "string") return null;

  const row: RecoveryWalRecord = {
    schema: "brewva.recovery-wal.v1",
    walId: asBrewvaWalId(value.walId),
    turnId: value.turnId,
    sessionId: asBrewvaSessionId(value.sessionId),
    channel: value.channel,
    conversationId: value.conversationId,
    status: value.status,
    envelope,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    attempts: value.attempts,
    source: value.source,
  };
  if (value.error !== undefined) {
    row.error = value.error;
  }
  if (value.ttlMs !== undefined) {
    row.ttlMs = value.ttlMs;
  }
  if (value.dedupeKey !== undefined) {
    row.dedupeKey = value.dedupeKey;
  }
  return row;
}

function parseRecoveryWalIngressWatermarkRecord(
  line: string,
): RecoveryWalIngressWatermarkRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.schema !== "brewva.recovery-wal.ingress-watermark.v1") return null;
  if (!isRecoveryWalSource(value.source)) return null;
  if (typeof value.channel !== "string" || !value.channel.trim()) return null;
  if (
    typeof value.ingressSequence !== "number" ||
    !Number.isFinite(value.ingressSequence) ||
    !Number.isInteger(value.ingressSequence) ||
    value.ingressSequence < 0
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
  return {
    schema: "brewva.recovery-wal.ingress-watermark.v1",
    source: value.source,
    channel: value.channel.trim().toLowerCase(),
    ingressSequence: value.ingressSequence,
    updatedAt: value.updatedAt,
  };
}

function sanitizeScopeId(scope: string): string {
  const normalized = scope.trim().replaceAll(/[^\w.-]+/g, "_");
  return normalized || "default";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cloneRecoveryWalRecord(row: RecoveryWalRecord): RecoveryWalRecord {
  return structuredClone(row);
}

function readIngressSequence(row: RecoveryWalRecord): number | undefined {
  const meta = isRecord(row.envelope.meta) ? row.envelope.meta : null;
  const ingressSequence = meta?.ingressSequence;
  if (
    typeof ingressSequence === "number" &&
    Number.isFinite(ingressSequence) &&
    Number.isInteger(ingressSequence) &&
    ingressSequence >= 0
  ) {
    return ingressSequence;
  }
  return undefined;
}

function normalizeIngressChannel(channel: string): string | undefined {
  const normalized = normalizeOptionalString(channel)?.toLowerCase();
  return normalized;
}

function buildIngressWatermarkKey(input: { source: RecoveryWalSource; channel: string }): string {
  return `${input.source}:${input.channel}`;
}

function createIngressWatermarkFromRecord(
  row: RecoveryWalRecord,
): RecoveryWalIngressWatermarkRecord | undefined {
  const ingressSequence = readIngressSequence(row);
  if (ingressSequence === undefined) {
    return undefined;
  }
  const channel = normalizeIngressChannel(row.channel);
  if (!channel) {
    return undefined;
  }
  return {
    schema: "brewva.recovery-wal.ingress-watermark.v1",
    source: row.source,
    channel,
    ingressSequence,
    updatedAt: Math.max(row.createdAt, row.updatedAt),
  };
}

function compareIngressWatermarks(
  left: RecoveryWalIngressWatermarkRecord,
  right: RecoveryWalIngressWatermarkRecord,
): number {
  if (left.source !== right.source) {
    return left.source.localeCompare(right.source);
  }
  if (left.channel !== right.channel) {
    return left.channel.localeCompare(right.channel);
  }
  if (left.ingressSequence !== right.ingressSequence) {
    return left.ingressSequence - right.ingressSequence;
  }
  return left.updatedAt - right.updatedAt;
}

function mergeIngressWatermarkCandidate(
  target: Map<string, RecoveryWalIngressWatermarkRecord>,
  candidate: RecoveryWalIngressWatermarkRecord,
): void {
  const key = buildIngressWatermarkKey({
    source: candidate.source,
    channel: candidate.channel,
  });
  const existing = target.get(key);
  if (!existing) {
    target.set(key, candidate);
    return;
  }
  if (candidate.ingressSequence > existing.ingressSequence) {
    target.set(key, candidate);
    return;
  }
  if (
    candidate.ingressSequence === existing.ingressSequence &&
    candidate.updatedAt > existing.updatedAt
  ) {
    target.set(key, candidate);
  }
}

function compareByCreatedAt(left: RecoveryWalRecord, right: RecoveryWalRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.updatedAt - right.updatedAt;
}

export class RecoveryWalStore {
  readonly workspaceRoot: string;
  readonly scope: string;
  readonly filePath: string;
  readonly config: BrewvaConfig["infrastructure"]["recoveryWal"];

  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private readonly scheduleTurnTtlMs: number;
  private readonly toolTurnTtlMs: number;
  private readonly compactAfterMs: number;
  private readonly recordEvent?:
    | ((input: { sessionId: string; type: string; payload?: object }) => void)
    | undefined;
  private readonly cacheByFilePath = new Map<string, RecoveryWalFileCache>();
  private integrityIssues: IntegrityIssue[] = [];
  private fileHasContent: boolean | null = null;

  constructor(options: RecoveryWalStoreOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.config = { ...options.config };
    this.scope = sanitizeScopeId(options.scope);
    this.enabled = options.config.enabled;
    this.now = options.now ?? (() => Date.now());
    this.defaultTtlMs = Math.max(1, Math.floor(options.config.defaultTtlMs));
    this.scheduleTurnTtlMs = Math.max(1, Math.floor(options.config.scheduleTurnTtlMs));
    this.toolTurnTtlMs = Math.max(1, Math.floor(options.config.toolTurnTtlMs));
    this.compactAfterMs = Math.max(1, Math.floor(options.config.compactAfterMs));
    this.recordEvent = options.recordEvent;
    const walDir = resolve(this.workspaceRoot, options.config.dir);
    this.filePath = resolve(walDir, `${this.scope}.jsonl`);
    if (this.enabled) {
      ensureDir(walDir);
    }
  }

  private buildIntegrityError(reason: string): Error {
    return new Error(`recovery_wal_integrity_error:${this.scope}:${reason}`);
  }

  getIntegrityIssues(): IntegrityIssue[] {
    if (this.enabled) {
      try {
        this.syncCache();
      } catch {
        // Integrity access should surface persisted issues without throwing to callers.
      }
    }
    return this.integrityIssues.map((issue) => ({ ...issue }));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  appendPending(
    envelope: TurnEnvelope,
    source: RecoveryWalSource,
    options: RecoveryWalAppendPendingOptions = {},
  ): RecoveryWalRecord {
    const timestamp = this.now();
    const turnId = normalizeOptionalString(envelope.turnId) ?? `turn_${timestamp}_${randomUUID()}`;
    const sessionId = normalizeOptionalString(envelope.sessionId) ?? "unknown";
    const channel = normalizeOptionalString(envelope.channel) ?? "unknown";
    const conversationId = normalizeOptionalString(envelope.conversationId) ?? "unknown";
    const dedupeKey = normalizeOptionalString(options.dedupeKey);
    const ttlMs = this.resolveTtlMs(source, options.ttlMs);

    if (this.enabled && dedupeKey) {
      const existing = this.findRecoverableByDedupeKey(dedupeKey);
      if (existing) {
        if (!this.isExpired(existing, timestamp)) {
          return cloneRecoveryWalRecord(existing);
        }

        this.markExpired(existing.walId);
      }
    }

    const row: RecoveryWalRecord = {
      schema: "brewva.recovery-wal.v1",
      walId: asBrewvaWalId(`wal_${timestamp}_${randomUUID()}`),
      turnId,
      sessionId: asBrewvaSessionId(sessionId),
      channel,
      conversationId,
      status: "pending",
      envelope: structuredClone(envelope),
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      source,
      ttlMs,
      dedupeKey,
    };

    if (this.enabled) {
      this.appendRecord(row);
    }
    this.emitAppended(row);
    return cloneRecoveryWalRecord(row);
  }

  markInflight(walId: BrewvaWalId): RecoveryWalRecord | undefined {
    return this.transitionStatus(walId, "inflight", {
      attemptsDelta: 1,
    });
  }

  markDone(walId: BrewvaWalId): RecoveryWalRecord | undefined {
    return this.transitionStatus(walId, "done");
  }

  markFailed(walId: BrewvaWalId, error?: string): RecoveryWalRecord | undefined {
    return this.transitionStatus(walId, "failed", {
      error: normalizeOptionalString(error),
    });
  }

  markExpired(walId: BrewvaWalId): RecoveryWalRecord | undefined {
    return this.transitionStatus(walId, "expired");
  }

  listPending(): RecoveryWalRecord[] {
    if (!this.enabled) return [];
    const rows = [...this.syncCache().rowsByWalId.values()]
      .filter((row) => RECOVERABLE_STATUSES.has(row.status))
      .toSorted(compareByCreatedAt);
    return rows.map((row) => cloneRecoveryWalRecord(row));
  }

  listCurrent(): RecoveryWalRecord[] {
    if (!this.enabled) return [];
    return [...this.syncCache().rowsByWalId.values()]
      .toSorted(compareByCreatedAt)
      .map((row) => cloneRecoveryWalRecord(row));
  }

  getIngressHighWatermark(input: {
    source: RecoveryWalSource;
    channel: string;
  }): number | undefined {
    if (!this.enabled) return undefined;
    const channel = normalizeIngressChannel(input.channel);
    if (!channel) return undefined;

    const cache = this.syncCache();
    const key = buildIngressWatermarkKey({
      source: input.source,
      channel,
    });

    let watermark = cache.ingressWatermarksByKey.get(key)?.ingressSequence;
    for (const row of cache.rowsByWalId.values()) {
      if (row.source !== input.source) continue;
      if (normalizeIngressChannel(row.channel) !== channel) continue;
      const ingressSequence = readIngressSequence(row);
      if (ingressSequence === undefined) continue;
      watermark = watermark === undefined ? ingressSequence : Math.max(watermark, ingressSequence);
    }
    return watermark;
  }

  compact(): RecoveryWalCompactResult {
    if (!this.enabled) {
      return {
        scope: this.scope,
        filePath: this.filePath,
        scanned: 0,
        retained: 0,
        dropped: 0,
      };
    }

    const now = this.now();
    const cache = this.syncCache();
    const current = [...cache.rowsByWalId.values()].toSorted(compareByCreatedAt);
    const retainedRows = current.filter((row) => {
      if (!TERMINAL_STATUSES.has(row.status)) return true;
      return row.updatedAt + this.compactAfterMs > now;
    });
    const watermarkCandidates = new Map<string, RecoveryWalIngressWatermarkRecord>();
    for (const watermark of cache.ingressWatermarksByKey.values()) {
      mergeIngressWatermarkCandidate(watermarkCandidates, watermark);
    }
    for (const row of current) {
      const watermark = createIngressWatermarkFromRecord(row);
      if (!watermark) continue;
      mergeIngressWatermarkCandidate(watermarkCandidates, watermark);
    }

    const persistedWatermarks = [...watermarkCandidates.values()]
      .filter((watermark) => {
        for (const row of retainedRows) {
          if (row.source !== watermark.source) continue;
          if (normalizeIngressChannel(row.channel) !== watermark.channel) continue;
          if (readIngressSequence(row) === watermark.ingressSequence) {
            return false;
          }
        }
        return true;
      })
      .toSorted(compareIngressWatermarks);
    const dropped = current.length - retainedRows.length;
    const persistedEntries = [...persistedWatermarks, ...retainedRows];
    const content =
      persistedEntries.length > 0
        ? `${persistedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
        : "";
    writeFileAtomic(this.filePath, content);

    const nextCache: RecoveryWalFileCache = {
      rowsByWalId: new Map(retainedRows.map((row) => [row.walId, row])),
      ingressWatermarksByKey: new Map(
        persistedWatermarks.map((watermark) => [
          buildIngressWatermarkKey({
            source: watermark.source,
            channel: watermark.channel,
          }),
          watermark,
        ]),
      ),
      byteOffset: Buffer.byteLength(content, "utf8"),
      trailingFragment: "",
    };
    this.cacheByFilePath.set(this.filePath, nextCache);
    this.fileHasContent = persistedEntries.length > 0;

    const result: RecoveryWalCompactResult = {
      scope: this.scope,
      filePath: this.filePath,
      scanned: current.length,
      retained: persistedEntries.length,
      dropped,
    };
    this.emitCompacted(result);
    return result;
  }

  static listScopeIds(input: { workspaceRoot: string; dir: string }): string[] {
    const root = resolve(input.workspaceRoot, input.dir);
    if (!existsSync(root)) return [];
    const scopes: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const scope = entry.name.slice(0, -".jsonl".length).trim();
      if (!scope) continue;
      scopes.push(scope);
    }
    return scopes.toSorted((left, right) => left.localeCompare(right));
  }

  private resolveTtlMs(source: RecoveryWalSource, overrideTtlMs: number | undefined): number {
    if (typeof overrideTtlMs === "number" && Number.isFinite(overrideTtlMs) && overrideTtlMs > 0) {
      return Math.floor(overrideTtlMs);
    }
    if (source === "schedule") return this.scheduleTurnTtlMs;
    if (source === "tool") return this.toolTurnTtlMs;
    return this.defaultTtlMs;
  }

  private isExpired(record: RecoveryWalRecord, nowMs: number): boolean {
    const ttlMs =
      typeof record.ttlMs === "number" && Number.isFinite(record.ttlMs) && record.ttlMs > 0
        ? Math.floor(record.ttlMs)
        : record.source === "schedule"
          ? this.scheduleTurnTtlMs
          : record.source === "tool"
            ? this.toolTurnTtlMs
            : this.defaultTtlMs;
    const lastActivity = Math.max(record.createdAt, record.updatedAt);
    return lastActivity + ttlMs < nowMs;
  }

  private findRecoverableByDedupeKey(dedupeKey: string): RecoveryWalRecord | undefined {
    let candidate: RecoveryWalRecord | undefined;
    for (const row of this.syncCache().rowsByWalId.values()) {
      if (!row || row.dedupeKey !== dedupeKey) continue;
      if (!RECOVERABLE_STATUSES.has(row.status)) continue;
      if (!candidate) {
        candidate = row;
        continue;
      }
      if (compareByCreatedAt(candidate, row) < 0) {
        candidate = row;
      }
    }
    return candidate;
  }

  private transitionStatus(
    walId: BrewvaWalId,
    status: RecoveryWalStatus,
    options: {
      attemptsDelta?: number;
      error?: string;
    } = {},
  ): RecoveryWalRecord | undefined {
    if (!this.enabled) return undefined;
    const current = this.syncCache().rowsByWalId.get(walId);
    if (!current) return undefined;
    if (TERMINAL_STATUSES.has(current.status) && status !== current.status) {
      return undefined;
    }
    const timestamp = this.now();
    const attemptsDelta =
      typeof options.attemptsDelta === "number" && Number.isFinite(options.attemptsDelta)
        ? Math.floor(options.attemptsDelta)
        : 0;
    const next: RecoveryWalRecord = {
      ...current,
      status,
      updatedAt: timestamp,
      attempts: Math.max(0, current.attempts + attemptsDelta),
    };

    if (status === "failed") {
      next.error = options.error ?? current.error ?? "recovery_wal_failed";
    } else {
      delete next.error;
    }

    this.appendRecord(next);
    this.emitStatusChanged({
      previous: current,
      next,
    });
    return cloneRecoveryWalRecord(next);
  }

  private appendRecord(row: RecoveryWalRecord): void {
    ensureDirForFile(this.filePath);
    if (!existsSync(this.filePath)) {
      this.fileHasContent = false;
      this.cacheByFilePath.delete(this.filePath);
    }
    const prefix = this.hasContent() ? "\n" : "";
    const serialized = JSON.stringify(row);
    const appended = `${prefix}${serialized}`;
    writeFileSync(this.filePath, appended, { flag: "a" });
    this.fileHasContent = true;
    this.trackAppendedRow(row, appended);
  }

  private hasContent(): boolean {
    if (this.fileHasContent !== null) {
      return this.fileHasContent;
    }
    if (!existsSync(this.filePath)) {
      this.fileHasContent = false;
      return false;
    }

    try {
      this.fileHasContent = statSync(this.filePath).size > 0;
    } catch {
      this.fileHasContent = false;
    }
    return this.fileHasContent;
  }

  private syncCache(): RecoveryWalFileCache {
    if (!existsSync(this.filePath)) {
      this.clearIntegrityIssues();
      const empty: RecoveryWalFileCache = {
        rowsByWalId: new Map(),
        ingressWatermarksByKey: new Map(),
        byteOffset: 0,
        trailingFragment: "",
      };
      this.cacheByFilePath.set(this.filePath, empty);
      this.fileHasContent = false;
      return empty;
    }

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch {
      this.setIntegrityIssue({
        reason: "recovery_wal_stat_failed",
      });
      throw this.buildIntegrityError("stat_failed");
    }

    this.fileHasContent = size > 0;
    const cached = this.cacheByFilePath.get(this.filePath);
    if (!cached || size < cached.byteOffset) {
      return this.rebuildCache(size);
    }
    if (size === cached.byteOffset) {
      return cached;
    }

    const appended = this.readTextRange(cached.byteOffset, size);
    this.consumeChunk(cached, appended);
    cached.byteOffset = size;
    return cached;
  }

  private rebuildCache(size: number): RecoveryWalFileCache {
    const cache: RecoveryWalFileCache = {
      rowsByWalId: new Map(),
      ingressWatermarksByKey: new Map(),
      byteOffset: size,
      trailingFragment: "",
    };
    if (size > 0) {
      let text = "";
      try {
        text = readFileSync(this.filePath, "utf8");
      } catch {
        this.setIntegrityIssue({
          reason: "recovery_wal_read_failed",
        });
        throw this.buildIntegrityError("read_failed");
      }
      this.consumeChunk(cache, text);
    }
    this.clearIntegrityIssues();
    this.cacheByFilePath.set(this.filePath, cache);
    return cache;
  }

  private readTextRange(fromOffset: number, toOffset: number): string {
    const length = Math.max(0, toOffset - fromOffset);
    if (length <= 0) return "";
    const fd = openSync(this.filePath, "r");
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

  private consumeChunk(cache: RecoveryWalFileCache, text: string): void {
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
      const parsed = parseRecoveryWalRecord(trimmed);
      if (parsed) {
        cache.rowsByWalId.set(parsed.walId, parsed);
        continue;
      }
      const watermark = parseRecoveryWalIngressWatermarkRecord(trimmed);
      if (watermark) {
        cache.ingressWatermarksByKey.set(
          buildIngressWatermarkKey({
            source: watermark.source,
            channel: watermark.channel,
          }),
          watermark,
        );
        continue;
      }

      if (index === lines.length - 1) {
        cache.trailingFragment = raw;
        continue;
      }
      this.setIntegrityIssue({
        reason: "recovery_wal_malformed_row",
        index,
      });
      throw this.buildIntegrityError(`malformed_row:${index}`);
    }
  }

  private trackAppendedRow(row: RecoveryWalRecord, appended: string): void {
    const cached = this.cacheByFilePath.get(this.filePath);
    if (!cached) return;
    if (cached.trailingFragment) {
      this.cacheByFilePath.delete(this.filePath);
      return;
    }
    cached.rowsByWalId.set(row.walId, row);
    cached.byteOffset += Buffer.byteLength(appended, "utf8");
  }

  private emitAppended(record: RecoveryWalRecord): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "recovery_wal_appended",
      payload: {
        scope: this.scope,
        walId: record.walId,
        turnId: record.turnId,
        sessionId: record.sessionId,
        channel: record.channel,
        conversationId: record.conversationId,
        source: record.source,
        status: record.status,
        attempts: record.attempts,
      },
    });
  }

  private emitStatusChanged(input: { previous: RecoveryWalRecord; next: RecoveryWalRecord }): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "recovery_wal_status_changed",
      payload: {
        scope: this.scope,
        walId: input.next.walId,
        turnId: input.next.turnId,
        from: input.previous.status,
        to: input.next.status,
        attempts: input.next.attempts,
        error: input.next.error ?? null,
      },
    });
  }

  private emitCompacted(result: RecoveryWalCompactResult): void {
    this.recordEvent?.({
      sessionId: this.getSystemSessionId(),
      type: "recovery_wal_compacted",
      payload: {
        scope: result.scope,
        scanned: result.scanned,
        retained: result.retained,
        dropped: result.dropped,
      },
    });
  }

  private getSystemSessionId(): string {
    return `recovery_wal:${this.scope}`;
  }

  private setIntegrityIssue(input: { reason: string; index?: number }): void {
    this.integrityIssues = [
      {
        domain: "recovery_wal",
        severity: "unavailable",
        reason: input.reason,
        index: input.index,
      },
    ];
  }

  private clearIntegrityIssues(): void {
    this.integrityIssues = [];
  }
}
