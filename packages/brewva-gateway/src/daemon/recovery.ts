import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { asBrewvaWalId, type BrewvaWalId } from "@brewva/brewva-runtime/core";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  ProtocolRecord,
} from "@brewva/brewva-vocabulary/events";
import type { ScheduleIntentProjectionRecord } from "@brewva/brewva-vocabulary/schedule";
import type {
  RecoveryWalRecord,
  RecoveryWalRecoveryResult,
  RecoveryWalSource,
  RecoveryWalStatus,
} from "@brewva/brewva-vocabulary/session";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";

type WalRecord = Record<string, unknown>;
export type RecoveryWalStoredRecord = RecoveryWalRecord & {
  readonly schema: typeof RECOVERY_WAL_ROW_SCHEMA;
  readonly scope: string;
  readonly walId: BrewvaWalId;
  readonly source: RecoveryWalSource;
  readonly status: RecoveryWalStatus;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ttlMs: number;
  readonly attempts: number;
  readonly dedupeKey?: string;
};
type RecoveryWalLifecycleEvent = {
  readonly sessionId: string;
  readonly type: string;
  readonly payload?: object;
};
type RuntimeEventListener = (event: BrewvaEventRecord) => void;
type SchedulerIntentRecord = ScheduleIntentProjectionRecord & {
  readonly id: string;
  readonly kind?: string;
  readonly error?: string;
  readonly updatedAt: number;
  readonly nextRunAt?: number | null;
};
interface RecoveryWalConfig extends WalRecord {
  readonly dir?: string;
  readonly toolTurnTtlMs?: number;
  readonly scheduleTurnTtlMs?: number;
  readonly defaultTtlMs?: number;
  readonly compactAfterMs?: number;
  readonly maxRetries?: number;
}

const RECOVERY_WAL_ROW_SCHEMA = "brewva.recovery-wal.v1";
const RECOVERY_WAL_WATERMARK_SCHEMA = "brewva.recovery-wal.watermark.v1";
const DEFAULT_RECOVERY_WAL_DIR = ".orchestrator/recovery-wal";
const TERMINAL_WAL_STATUSES = new Set(["done", "failed", "expired"]);
const RECOVERABLE_WAL_STATUSES = new Set(["pending", "inflight"]);

function readRecord(value: unknown): WalRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProtocolRecord)
    : {};
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function isTurnEnvelope(value: unknown): value is TurnEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as ProtocolRecord;
  return (
    typeof record.schema === "string" &&
    typeof record.channel === "string" &&
    typeof record.conversationId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.turnId === "string" &&
    Array.isArray(record.parts)
  );
}

export type {
  RecoveryWalRecord,
  RecoveryWalRecoveryResult,
  RecoveryWalSource,
  RecoveryWalStatus,
} from "@brewva/brewva-vocabulary/session";

export interface RecoveryWalAppendPendingOptions extends WalRecord {}
export interface RecoveryWalCompactResult {
  readonly removed: number;
  readonly scanned: number;
  readonly retained: number;
  readonly dropped: number;
}
export interface RecoveryWalStoreOptions {
  readonly scope?: string;
  readonly enabled?: boolean;
  readonly workspaceRoot?: string;
  readonly cwd?: string;
  readonly config?: RecoveryWalConfig;
  readonly now?: () => number;
  readonly recordEvent?: (input: RecoveryWalLifecycleEvent) => void;
}
export interface RecoveryWalRecoverHandlerInput {
  readonly record: RecoveryWalStoredRecord;
  readonly store: RecoveryWalStore;
}
export type RecoveryWalRecoverHandler = (
  input: RecoveryWalRecoverHandlerInput,
) => Promise<void> | void;
export interface RecoveryWalRecoveryError {
  readonly record: RecoveryWalStoredRecord;
  readonly error: unknown;
}
export interface RecoveryWalRecoveryOptions {
  readonly handler?: RecoveryWalRecoverHandler;
}
export interface SchedulerRuntimePort {
  readonly workspaceRoot?: string;
  readonly scheduleConfig?: unknown;
  readonly scheduleEvents?: {
    readonly recordIntent?: (input: WalRecord) => unknown;
    readonly recordWakeup?: (sessionId: string, input: object) => unknown;
    readonly recordChildStarted?: (sessionId: string, input: object) => unknown;
    readonly recordChildFinished?: (sessionId: string, input: object) => unknown;
    readonly recordChildFailed?: (sessionId: string, input: object) => unknown;
  };
  readonly turn?: (input: WalRecord) => AsyncIterable<unknown>;
  readonly listSessionIds?: () => readonly string[];
  readonly listEvents?: (
    sessionId: string,
    query?: BrewvaEventQuery,
  ) => readonly BrewvaEventRecord[];
  readonly subscribeEvents?: (listener: RuntimeEventListener) => () => void | boolean;
  readonly getClaimState?: (sessionId: string) => unknown;
  readonly getTaskState?: (sessionId: string) => unknown;
  readonly recoveryWal?: {
    readonly appendPending?: (
      envelope: TurnEnvelope,
      source?: RecoveryWalSource,
      appendOptions?: RecoveryWalAppendPendingOptions,
    ) => RecoveryWalStoredRecord;
    readonly markInflight?: (walId: string) => RecoveryWalStoredRecord | undefined;
    readonly markDone?: (walId: string) => RecoveryWalStoredRecord | undefined;
    readonly markFailed?: (walId: string, error?: unknown) => RecoveryWalStoredRecord | undefined;
    readonly markExpired?: (walId: string) => RecoveryWalStoredRecord | undefined;
    readonly listPending?: () => readonly RecoveryWalStoredRecord[];
  };
}
export interface SchedulerServiceOptions {
  readonly runtime?: SchedulerRuntimePort;
  readonly shouldExecute?: () => boolean;
  readonly executeIntent?: (intent: ScheduleIntentProjectionRecord) => Promise<unknown> | void;
}
export interface SchedulerStats {
  readonly executionEnabled: boolean;
  readonly intentCount: number;
  readonly intentsActive: number;
  readonly intentsTotal: number;
  readonly timersArmed: number;
  readonly projectionPath?: string;
  readonly watermarkOffset?: number;
}
export interface SchedulerCatchUpSummary {
  readonly dueIntents: number;
  readonly firedIntents: number;
  readonly deferredIntents: number;
  readonly sessions: readonly string[];
}
export interface SchedulerRecoverResult {
  readonly recovered: boolean;
  readonly runtime: boolean;
  readonly rebuiltFromEvents: boolean;
  readonly projectionMatched: boolean;
  readonly catchUp: SchedulerCatchUpSummary;
}
export type ScheduleIntentExecutionResult =
  | ({ readonly ok: true; readonly intent: ScheduleIntentProjectionRecord } & WalRecord)
  | { readonly ok: false; readonly reason: string };

export interface RecoveryWalStore {
  readonly name: "recovery.wal-store";
  getScope(): string;
  isWalEnabled(): boolean;
  getIntegrityIssues(): readonly string[];
  appendPending(
    envelope: TurnEnvelope,
    source?: RecoveryWalSource,
    appendOptions?: RecoveryWalAppendPendingOptions,
  ): RecoveryWalStoredRecord;
  markInflight(id: string): RecoveryWalStoredRecord | undefined;
  markDone(id: string): RecoveryWalStoredRecord | undefined;
  markFailed(id: string, error?: unknown): RecoveryWalStoredRecord | undefined;
  markExpired(id: string): RecoveryWalStoredRecord | undefined;
  listPending(): readonly RecoveryWalStoredRecord[];
  listCurrent(): readonly RecoveryWalStoredRecord[];
  getIngressHighWatermark(...args: unknown[]): number | undefined;
  compact(...args: unknown[]): RecoveryWalCompactResult;
}

export interface RecoveryWalRecovery {
  readonly name: "recovery.wal-recovery";
  recover(options?: RecoveryWalRecoveryOptions): Promise<RecoveryWalRecoveryResult>;
}

export interface SchedulerService {
  readonly name: "recovery.scheduler-service";
  getProjectionPath(): string | null;
  snapshot(): WalRecord;
  getStats(): SchedulerStats;
  stop(): void;
  syncExecutionState(): void;
  recover(): Promise<SchedulerRecoverResult>;
  createIntent(input: WalRecord): ScheduleIntentExecutionResult;
  cancelIntent(input: WalRecord): ScheduleIntentExecutionResult;
  updateIntent(input: WalRecord, ...args: unknown[]): ScheduleIntentExecutionResult;
  listIntents(query?: WalRecord): readonly SchedulerIntentRecord[];
}

export function createRecoveryWalStore(options: RecoveryWalStoreOptions = {}): RecoveryWalStore {
  const scope = options.scope ?? "default";
  const enabled = options.enabled ?? true;
  const workspaceRoot = options.workspaceRoot ?? options.cwd ?? process.cwd();
  const config = options.config ?? {};
  const walDir = resolve(
    workspaceRoot,
    typeof config.dir === "string" && config.dir.trim().length > 0
      ? config.dir
      : DEFAULT_RECOVERY_WAL_DIR,
  );
  const walFilePath = resolve(walDir, `${scope}.jsonl`);
  const nowProvider = options.now;
  const now = nowProvider ? () => nowProvider() : () => Date.now();
  const records = new Map<string, RecoveryWalStoredRecord>();
  const integrityIssues: string[] = [];
  let idCounter = 0;
  let ingressWatermark: number | undefined;
  let loaded = false;

  function ttlForSource(source: string, override?: unknown): number {
    if (typeof override === "number" && Number.isFinite(override) && override > 0) {
      return Math.trunc(override);
    }
    if (source === "tool" && typeof config.toolTurnTtlMs === "number") {
      return Math.trunc(config.toolTurnTtlMs);
    }
    if (source === "schedule" && typeof config.scheduleTurnTtlMs === "number") {
      return Math.trunc(config.scheduleTurnTtlMs);
    }
    return typeof config.defaultTtlMs === "number" ? Math.trunc(config.defaultTtlMs) : 300_000;
  }

  function compactAfterMs(): number {
    return typeof config.compactAfterMs === "number"
      ? Math.trunc(config.compactAfterMs)
      : 3_600_000;
  }

  function assertHealthy(): void {
    if (integrityIssues.length > 0) {
      throw new Error(`recovery_wal_integrity_error:${integrityIssues.join(";")}`);
    }
  }

  function walLine(value: WalRecord | RecoveryWalStoredRecord): string {
    return `${JSON.stringify(value)}\n`;
  }

  function ensureWalDir(): void {
    mkdirSync(walDir, { recursive: true });
  }

  function appendWalLine(value: WalRecord): void {
    ensureWalDir();
    appendFileSync(walFilePath, walLine(value), "utf8");
  }

  function rewriteWalFile(): void {
    ensureWalDir();
    const lines: string[] = [];
    if (ingressWatermark !== undefined) {
      lines.push(
        walLine({
          schema: RECOVERY_WAL_WATERMARK_SCHEMA,
          scope,
          ingressWatermark,
          updatedAt: now(),
        }),
      );
    }
    for (const record of records.values()) {
      lines.push(walLine(record));
    }
    writeFileSync(walFilePath, lines.join(""), "utf8");
  }

  function resetIfWalFileWasRemoved(): void {
    if (!loaded || existsSync(walFilePath)) {
      return;
    }
    records.clear();
    integrityIssues.length = 0;
    idCounter = 0;
    ingressWatermark = undefined;
    loaded = true;
  }

  function recordIdNumber(id: unknown): number | null {
    if (typeof id !== "string") {
      return null;
    }
    const match = /^wal-(\d+)$/u.exec(id);
    return match ? Number(match[1]) : null;
  }

  function toStoredRecord(row: WalRecord): RecoveryWalStoredRecord | null {
    if (
      row.schema !== RECOVERY_WAL_ROW_SCHEMA ||
      typeof row.walId !== "string" ||
      typeof row.source !== "string" ||
      typeof row.status !== "string" ||
      !isTurnEnvelope(row.envelope)
    ) {
      return null;
    }
    const createdAt = readFiniteNumber(row.createdAt, Date.now());
    const updatedAt = readFiniteNumber(row.updatedAt, createdAt);
    const ttlMs = readFiniteNumber(row.ttlMs, ttlForSource(row.source));
    const attempts = readFiniteNumber(row.attempts, 0);
    const walId = asBrewvaWalId(row.walId);
    return Object.freeze({
      ...row,
      schema: RECOVERY_WAL_ROW_SCHEMA,
      id: typeof row.id === "string" ? row.id : walId,
      walId,
      scope,
      source: row.source,
      status: row.status,
      sessionId: row.envelope.sessionId,
      envelope: row.envelope,
      createdAt,
      updatedAt,
      ttlMs,
      attempts,
      ...(typeof row.dedupeKey === "string" ? { dedupeKey: row.dedupeKey } : {}),
    });
  }

  function applyLoadedLine(value: unknown, lineNumber: number): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      integrityIssues.push(`${walFilePath}:${lineNumber}:not_object`);
      return;
    }
    const row = readRecord(value);
    if (row.schema === RECOVERY_WAL_WATERMARK_SCHEMA) {
      if (typeof row.ingressWatermark === "number" && Number.isFinite(row.ingressWatermark)) {
        ingressWatermark = Math.max(ingressWatermark ?? 0, Math.trunc(row.ingressWatermark));
      }
      return;
    }
    const stored = toStoredRecord(row);
    if (!stored) {
      integrityIssues.push(`${walFilePath}:${lineNumber}:invalid_schema`);
      return;
    }
    const numericId = recordIdNumber(stored.walId);
    if (numericId !== null) {
      idCounter = Math.max(idCounter, numericId);
    }
    records.set(stored.walId, stored);
    observeIngressWatermark(stored.envelope);
  }

  function loadFromDisk(): void {
    if (loaded) {
      return;
    }
    loaded = true;
    records.clear();
    integrityIssues.length = 0;
    idCounter = 0;
    ingressWatermark = undefined;
    if (!existsSync(walFilePath)) {
      return;
    }
    const lines = readFileSync(walFilePath, "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        applyLoadedLine(JSON.parse(line), index + 1);
      } catch {
        integrityIssues.push(`${walFilePath}:${index + 1}:invalid_json`);
      }
    }
  }

  function refreshFromDisk(): void {
    loaded = false;
    loadFromDisk();
  }

  function observeIngressWatermark(record: WalRecord | TurnEnvelope): void {
    const meta =
      record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
        ? readRecord(record.meta)
        : {};
    const ingressSequence = meta.ingressSequence ?? record.ingressSequence;
    if (typeof ingressSequence === "number" && Number.isFinite(ingressSequence)) {
      ingressWatermark = Math.max(ingressWatermark ?? 0, Math.trunc(ingressSequence));
    }
  }

  function isExpired(record: RecoveryWalStoredRecord, at = now()): boolean {
    return (
      typeof record.createdAt === "number" &&
      typeof record.ttlMs === "number" &&
      at - record.createdAt > record.ttlMs
    );
  }

  function update(
    id: string,
    status: RecoveryWalStatus,
    extra: WalRecord = {},
  ): RecoveryWalStoredRecord | undefined {
    loadFromDisk();
    assertHealthy();
    const current = records.get(id);
    if (!current || TERMINAL_WAL_STATUSES.has(current.status)) {
      return undefined;
    }
    const next = Object.freeze({
      ...current,
      status,
      updatedAt: now(),
      ...extra,
    }) as RecoveryWalStoredRecord;
    records.set(id, next);
    appendWalLine(next);
    return next;
  }

  return Object.freeze({
    name: "recovery.wal-store" as const,
    getScope: () => scope,
    isWalEnabled: () => enabled,
    getIntegrityIssues: () => {
      loadFromDisk();
      return [...integrityIssues];
    },
    appendPending(
      envelope: TurnEnvelope,
      source: RecoveryWalSource = "gateway",
      appendOptions: RecoveryWalAppendPendingOptions = {},
    ): RecoveryWalStoredRecord {
      loadFromDisk();
      assertHealthy();
      resetIfWalFileWasRemoved();
      const createdAt = now();
      const normalizedSource = source.trim().length > 0 ? source : "gateway";
      const ttlMs = ttlForSource(normalizedSource, appendOptions.ttlMs);
      const dedupeKey =
        typeof appendOptions.dedupeKey === "string" && appendOptions.dedupeKey.trim().length > 0
          ? appendOptions.dedupeKey
          : undefined;
      observeIngressWatermark(envelope);
      if (dedupeKey) {
        for (const current of records.values()) {
          if (current.dedupeKey !== dedupeKey || TERMINAL_WAL_STATUSES.has(current.status)) {
            continue;
          }
          if (!isExpired(current, createdAt)) {
            return current;
          }
          update(current.walId, "expired");
        }
      }
      const walId = asBrewvaWalId(`wal-${++idCounter}`);
      const stored: RecoveryWalStoredRecord = Object.freeze({
        schema: RECOVERY_WAL_ROW_SCHEMA,
        walId,
        id: walId,
        scope,
        source: normalizedSource,
        status: "pending",
        sessionId: envelope.sessionId,
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        ttlMs,
        ...(dedupeKey ? { dedupeKey } : {}),
        ...(appendOptions && typeof appendOptions === "object" ? appendOptions : {}),
        envelope,
      });
      records.set(walId, stored);
      appendWalLine(stored);
      return stored;
    },
    markInflight(id: string): RecoveryWalStoredRecord | undefined {
      loadFromDisk();
      const current = records.get(id);
      if (!current || TERMINAL_WAL_STATUSES.has(current.status)) {
        return undefined;
      }
      return update(id, "inflight", {
        attempts: Math.max(0, current.attempts) + 1,
      });
    },
    markDone: (id: string) => update(id, "done"),
    markFailed: (id: string, error?: unknown) => update(id, "failed", { error }),
    markExpired: (id: string) => update(id, "expired"),
    listPending(): readonly RecoveryWalStoredRecord[] {
      refreshFromDisk();
      assertHealthy();
      return [...records.values()].filter((record) => RECOVERABLE_WAL_STATUSES.has(record.status));
    },
    listCurrent(): readonly RecoveryWalStoredRecord[] {
      refreshFromDisk();
      assertHealthy();
      return [...records.values()];
    },
    getIngressHighWatermark(..._args: unknown[]): number | undefined {
      refreshFromDisk();
      assertHealthy();
      return ingressWatermark;
    },
    compact(): RecoveryWalCompactResult {
      refreshFromDisk();
      assertHealthy();
      const at = now();
      let removed = 0;
      let scanned = 0;
      for (const [id, record] of records) {
        scanned += 1;
        if (
          ["done", "expired"].includes(record.status) &&
          at - record.updatedAt > compactAfterMs()
        ) {
          records.delete(id);
          removed += 1;
        }
      }
      rewriteWalFile();
      return { removed, scanned, retained: records.size, dropped: removed };
    },
  });
}

export function createRecoveryWalRecovery(
  input: {
    readonly store?: RecoveryWalStore;
    readonly scopeFilter?: (scope: string) => boolean;
    readonly recordEvent?: (event: RecoveryWalLifecycleEvent) => void;
    readonly handlers?: Record<string, RecoveryWalRecoverHandler>;
    readonly workspaceRoot?: string;
    readonly cwd?: string;
    readonly config?: RecoveryWalConfig;
    readonly now?: () => number;
  } = {},
): RecoveryWalRecovery {
  const workspaceRoot = input.workspaceRoot ?? input.cwd ?? process.cwd();
  const config = input.config ?? {};
  const walDir = resolve(
    workspaceRoot,
    typeof config.dir === "string" && config.dir.trim().length > 0
      ? config.dir
      : DEFAULT_RECOVERY_WAL_DIR,
  );
  const maxRetryCount =
    typeof config.maxRetries === "number" ? Math.max(0, Math.trunc(config.maxRetries)) : 2;
  const recoveryNow = input.now ? () => input.now?.() ?? Date.now() : () => Date.now();

  function storesForRecovery(): RecoveryWalStore[] {
    if (input.store) {
      return [input.store];
    }
    if (!existsSync(walDir)) {
      return [];
    }
    return readdirSync(walDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.slice(0, -".jsonl".length))
      .filter((scope) => input.scopeFilter?.(scope) ?? true)
      .map((scope) =>
        createRecoveryWalStore({
          ...input,
          workspaceRoot,
          config,
          scope,
        }),
      );
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  return Object.freeze({
    name: "recovery.wal-recovery" as const,
    async recover(options: RecoveryWalRecoveryOptions = {}): Promise<RecoveryWalRecoveryResult> {
      const errors: RecoveryWalRecoveryError[] = [];
      let scanned = 0;
      let retried = 0;
      let expired = 0;
      let failed = 0;
      let skipped = 0;
      for (const store of storesForRecovery()) {
        for (const record of store.listPending()) {
          scanned += 1;
          if (
            typeof record.createdAt === "number" &&
            typeof record.ttlMs === "number" &&
            recoveryNow() - record.createdAt > record.ttlMs
          ) {
            store.markExpired(record.walId);
            expired += 1;
            continue;
          }
          if (record.attempts >= maxRetryCount) {
            store.markFailed(record.walId, "recovery_retries_exhausted");
            failed += 1;
            continue;
          }
          const handler = options.handler ?? input.handlers?.[record.source];
          if (!handler) {
            skipped += 1;
            continue;
          }
          try {
            await handler({ record, store });
            store.markDone(record.walId);
            retried += 1;
          } catch (error) {
            const message = `recovery_retry_failed:${errorMessage(error)}`;
            store.markFailed(record.walId, message);
            errors.push({ record, error });
            failed += 1;
          }
        }
      }
      return { scanned, retried, failed, expired, skipped, errors };
    },
  });
}

export function createSchedulerService(options: SchedulerServiceOptions = {}): SchedulerService {
  const intents = new Map<string, SchedulerIntentRecord>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function now(): number {
    return Date.now();
  }

  function readSchedulerRecord(value: unknown): WalRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as WalRecord) : {};
  }

  function intentIdFor(input: WalRecord): string {
    const raw = input.intentId ?? input.id;
    return typeof raw === "string" && raw.trim().length > 0 ? raw : `intent-${intents.size + 1}`;
  }

  function recordScheduleEvent(record: WalRecord, kind: string): void {
    const scheduleEvents = readSchedulerRecord(options.runtime).scheduleEvents;
    if (!scheduleEvents || typeof scheduleEvents !== "object" || Array.isArray(scheduleEvents)) {
      return;
    }
    const recordIntent = (scheduleEvents as { recordIntent?: unknown }).recordIntent;
    if (typeof recordIntent !== "function") {
      return;
    }
    recordIntent({ ...record, kind });
  }

  function statusFor(kind: unknown, previousStatus: unknown): string {
    if (kind === "intent_cancelled" || kind === "cancelled") {
      return "cancelled";
    }
    if (kind === "intent_converged" || kind === "converged") {
      return "converged";
    }
    if (typeof previousStatus === "string" && previousStatus.trim().length > 0) {
      return previousStatus;
    }
    return "active";
  }

  function upsertIntent(input: WalRecord): SchedulerIntentRecord {
    const id = intentIdFor(input);
    const previous = intents.get(id);
    const runCount =
      (typeof previous?.runCount === "number" ? previous.runCount : 0) +
      (input.kind === "intent_fired" || input.kind === "fired" ? 1 : 0);
    const maxRuns =
      typeof input.maxRuns === "number" && Number.isFinite(input.maxRuns)
        ? Math.max(1, Math.trunc(input.maxRuns))
        : typeof previous?.maxRuns === "number" && Number.isFinite(previous.maxRuns)
          ? Math.max(1, Math.trunc(previous.maxRuns))
          : 1;
    const status = statusFor(input.kind, input.status ?? previous?.status);
    const nextRunAt =
      status !== "active" || runCount >= maxRuns
        ? undefined
        : typeof input.nextRunAt === "number" && Number.isFinite(input.nextRunAt)
          ? Math.trunc(input.nextRunAt)
          : typeof input.runAt === "number" && Number.isFinite(input.runAt)
            ? Math.trunc(input.runAt)
            : typeof input.cron === "string" && input.cron.trim().length > 0
              ? now() + 60_000
              : undefined;
    const record: SchedulerIntentRecord = Object.freeze({
      ...previous,
      ...input,
      id,
      intentId: id,
      parentSessionId:
        typeof input.parentSessionId === "string" && input.parentSessionId.trim().length > 0
          ? input.parentSessionId
          : (previous?.parentSessionId ?? "default"),
      reason:
        typeof input.reason === "string" && input.reason.trim().length > 0
          ? input.reason
          : (previous?.reason ?? "scheduled"),
      continuityMode:
        typeof input.continuityMode === "string" && input.continuityMode.trim().length > 0
          ? input.continuityMode
          : (previous?.continuityMode ?? "resume"),
      status,
      runCount,
      maxRuns,
      nextRunAt,
      updatedAt: now(),
    });
    intents.set(id, record);
    return record;
  }

  function loadRuntimeEvents(): void {
    const runtime = options.runtime;
    if (!runtime?.listSessionIds || !runtime.listEvents) {
      return;
    }
    for (const sessionId of runtime.listSessionIds()) {
      for (const event of runtime.listEvents(sessionId, { type: "schedule.intent" })) {
        const payload = readSchedulerRecord(event.payload);
        upsertIntent({
          ...payload,
          parentSessionId: payload.parentSessionId ?? event.sessionId,
        });
      }
    }
  }

  async function fireIntent(record: SchedulerIntentRecord): Promise<void> {
    if (
      stopped ||
      options.shouldExecute?.() === false ||
      typeof options.executeIntent !== "function"
    ) {
      return;
    }
    const current = intents.get(record.intentId) ?? record;
    if (current.status !== "active") {
      return;
    }
    const maxRuns =
      typeof current.maxRuns === "number" && Number.isFinite(current.maxRuns)
        ? Math.max(1, Math.trunc(current.maxRuns))
        : 1;
    const runCount =
      typeof current.runCount === "number" && Number.isFinite(current.runCount)
        ? Math.max(0, Math.trunc(current.runCount))
        : 0;
    if (runCount >= maxRuns) {
      return;
    }
    const fired = upsertIntent({ ...current, kind: "intent_fired" });
    recordScheduleEvent(fired, "intent_fired");
    try {
      await options.executeIntent(fired);
      const converged = upsertIntent({
        ...fired,
        kind: "intent_converged",
        status: fired.runCount >= maxRuns ? "converged" : "active",
      });
      recordScheduleEvent(converged, "intent_converged");
    } catch (error) {
      const failed = upsertIntent({
        ...fired,
        kind: "intent_fired",
        error: error instanceof Error ? error.message : String(error),
      });
      recordScheduleEvent(failed, "intent_fired");
    }
  }

  function armIntent(record: SchedulerIntentRecord): void {
    if (stopped || record.status !== "active") {
      return;
    }
    const id = record.intentId;
    const maxRuns =
      typeof record.maxRuns === "number" && Number.isFinite(record.maxRuns)
        ? Math.max(1, Math.trunc(record.maxRuns))
        : 1;
    const runCount =
      typeof record.runCount === "number" && Number.isFinite(record.runCount)
        ? Math.max(0, Math.trunc(record.runCount))
        : 0;
    if (runCount >= maxRuns || timers.has(id)) {
      return;
    }
    const rawRunAt = record.runAt ?? record.nextRunAt;
    const runAt =
      typeof rawRunAt === "number" && Number.isFinite(rawRunAt) ? Math.trunc(rawRunAt) : null;
    if (runAt === null) {
      return;
    }
    const delayMs = Math.max(0, runAt - now());
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void fireIntent(record);
      }, delayMs),
    );
  }

  function reschedule(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    for (const intent of intents.values()) {
      armIntent(intent);
    }
  }

  function activeIntents(): SchedulerIntentRecord[] {
    return [...intents.values()].filter((intent) => intent.status === "active");
  }

  return Object.freeze({
    name: "recovery.scheduler-service" as const,
    getProjectionPath: () => null,
    snapshot: () => ({ intents: [...intents.values()] }),
    getStats: () => ({
      executionEnabled: typeof options.executeIntent === "function",
      intentCount: intents.size,
      intentsActive: activeIntents().length,
      intentsTotal: intents.size,
      timersArmed: timers.size,
    }),
    stop(): void {
      stopped = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
    syncExecutionState(): void {
      reschedule();
    },
    async recover(): Promise<SchedulerRecoverResult> {
      loadRuntimeEvents();
      reschedule();
      return {
        recovered: true,
        runtime: Boolean(options.runtime),
        rebuiltFromEvents: true,
        projectionMatched: true,
        catchUp: {
          dueIntents: activeIntents().length,
          firedIntents: 0,
          deferredIntents: 0,
          sessions: [],
        },
      };
    },
    createIntent(input: WalRecord): ScheduleIntentExecutionResult {
      const record = upsertIntent({ ...input, kind: "intent_created", status: "active" });
      recordScheduleEvent(record, "intent_created");
      armIntent(record);
      return { ok: true, intent: record, ...record };
    },
    cancelIntent(input: WalRecord): ScheduleIntentExecutionResult {
      loadRuntimeEvents();
      const id = intentIdFor(input);
      const existing = intents.get(id);
      const record = upsertIntent({
        ...(existing ?? input),
        ...input,
        kind: "intent_cancelled",
        status: "cancelled",
      });
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.delete(id);
      }
      recordScheduleEvent(record, "intent_cancelled");
      return { ok: true, intent: record, ...record };
    },
    updateIntent(input: WalRecord, ...args: unknown[]): ScheduleIntentExecutionResult {
      loadRuntimeEvents();
      const updateOptions = readSchedulerRecord(args[0]);
      const current = intents.get(intentIdFor(input));
      const status =
        updateOptions.allowInactiveReactivation === true && current?.status !== "active"
          ? "active"
          : input.status;
      const record = upsertIntent({
        ...input,
        ...(status ? { status } : {}),
        kind: "intent_updated",
      });
      recordScheduleEvent(record, "intent_updated");
      armIntent(record);
      return { ok: true, intent: record, ...record };
    },
    listIntents(query?: WalRecord): readonly SchedulerIntentRecord[] {
      loadRuntimeEvents();
      const parentSessionId =
        typeof query?.parentSessionId === "string" && query.parentSessionId.trim().length > 0
          ? query.parentSessionId
          : null;
      return [...intents.values()].filter(
        (intent) => parentSessionId === null || intent.parentSessionId === parentSessionId,
      );
    },
  });
}
