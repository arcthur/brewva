import { copyFileSync, mkdirSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  type CreateSessionIndexInput,
  type FilterSessionIdsByScopeInput,
  type ListSessionDigestsInput,
  type QueryRecentSessionsInput,
  type QuerySessionDigestsInput,
  type QueryTapeEvidenceInput,
  type SessionIndex,
  type SessionIndexBox,
  type SessionIndexDelegationRun,
  type SessionIndexDigest,
  type SessionIndexEventSource,
  type SessionIndexParallelBudgetView,
  type SessionIndexRecentSession,
  type SessionIndexRewindTarget,
  type SessionIndexStatus,
  type SessionIndexTapeEvidence,
  type SessionIndexTaskSource,
  type SessionIndexWorkerResult,
} from "./api.js";
import {
  acquireDuckDBInstance,
  type DuckDBConnection,
  type DuckDBInstanceHandle,
  type DuckDBModule,
} from "./duckdb/instance.js";
import {
  checkpointSessionIndex,
  clearSessionIndexRows,
  deleteSessionRows,
  ensureSessionIndexSchema,
  listIndexedSessionIds,
  readIndexedSessionState,
  readSessionIndexStatusCounts,
  runSessionIndexTransaction,
} from "./duckdb/lifecycle.js";
import { selectOne, selectRows, type JsonRow } from "./duckdb/query.js";
import { acquireWriteLease, type WriteLease } from "./lease/write-lease.js";
import { readEventsFromLog } from "./log-reader/jsonl.js";
import { listSessionBoxes as listProjectedSessionBoxes } from "./projection/box.js";
import {
  getParallelBudgetViewRow,
  listDelegationRunRows,
  listPendingDelegationOutcomeRows,
  listWorkerResultRows,
} from "./projection/delegation.js";
import { upsertSessionEvents } from "./projection/events.js";
import { listSessionRewindTargets as listProjectedSessionRewindTargets } from "./projection/rewind.js";
import { rebuildSessionProjection } from "./projection/session.js";
import {
  filterScopedSessionIds,
  getSessionDigestRow,
  listSessionDigestRows,
  querySessionDigestRows,
} from "./query/digests.js";
import { type SessionIndexQueryPort } from "./query/port.js";
import {
  getTapeEventRow,
  listRecentSessionRows,
  queryTapeEvidenceRows,
} from "./query/tape-evidence.js";
import {
  pruneReadSnapshots,
  resolvePublishedReadSnapshotPath,
  type ReadSnapshotManifest,
  writeReadSnapshotManifest,
} from "./snapshot/manifest.js";
import { type SqlParams } from "./sql/params.js";
import { SESSION_INDEX_UNAVAILABLE, SessionIndexUnavailableError } from "./unavailable.js";

const DEFAULT_DB_RELATIVE_PATH = join(".brewva", "session-index", "session-index.duckdb");
const DEFAULT_LOCK_RELATIVE_PATH = join(".brewva", "session-index", "write.lock");
const DEFAULT_SNAPSHOT_MANIFEST_RELATIVE_PATH = join(
  ".brewva",
  "session-index",
  "read-snapshot.json",
);
const DEFAULT_SNAPSHOT_DIR_RELATIVE_PATH = join(".brewva", "session-index", "snapshots");
const DUCKDB_NODE_API_PACKAGE = ["@duckdb", "node-api"].join("/");
const CATCH_UP_DEBOUNCE_MS = 5_000;

let duckdbModulePromise: Promise<DuckDBModule> | undefined;

export async function createSessionIndex(input: CreateSessionIndexInput): Promise<SessionIndex> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const dbPath = resolve(input.dbPath ?? join(workspaceRoot, DEFAULT_DB_RELATIVE_PATH));
  const snapshotManifestPath = resolve(
    join(workspaceRoot, DEFAULT_SNAPSHOT_MANIFEST_RELATIVE_PATH),
  );
  const snapshotDir = resolve(join(workspaceRoot, DEFAULT_SNAPSHOT_DIR_RELATIVE_PATH));
  mkdirSync(dirname(dbPath), { recursive: true });

  let duckdb: DuckDBModule;
  try {
    duckdb = await loadDuckDB();
  } catch (error) {
    return new UnavailableSessionIndex(dbPath, unavailableMessage(error));
  }

  const lease = acquireWriteLease(resolve(join(workspaceRoot, DEFAULT_LOCK_RELATIVE_PATH)));
  const readSnapshotPath = lease.acquired
    ? undefined
    : resolvePublishedReadSnapshotPath({
        manifestPath: snapshotManifestPath,
        snapshotDir,
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      });
  if (!lease.acquired && !readSnapshotPath) {
    return new UnavailableSessionIndex(
      dbPath,
      "session index writer lease unavailable and no read snapshot is published",
    );
  }
  const openDbPath = readSnapshotPath ?? dbPath;
  const openReadOnly = Boolean(readSnapshotPath);
  let instanceHandle: DuckDBInstanceHandle | undefined;
  try {
    instanceHandle = await acquireDuckDBInstance(duckdb, openDbPath, openReadOnly);
    const connection = await instanceHandle.instance.connect();
    const index = new DuckDBSessionIndex({
      workspaceRoot,
      dbPath,
      readSnapshotPath,
      snapshotManifestPath,
      snapshotDir,
      connection,
      events: input.events,
      task: input.task,
      writerLease: lease,
      instanceHandle,
    });
    const schemaStatus = await index.initialize();
    if (!schemaStatus.ok) {
      await index.close();
      return new UnavailableSessionIndex(dbPath, schemaStatus.message);
    }
    return index;
  } catch (error) {
    lease.release();
    instanceHandle?.release();
    return new UnavailableSessionIndex(dbPath, unavailableMessage(error));
  }
}

async function loadDuckDB(): Promise<DuckDBModule> {
  // Keep DuckDB out of Bun's compiled binary bundle; binary builds copy the
  // target native runtime packages beside the executable.
  duckdbModulePromise ??= import(DUCKDB_NODE_API_PACKAGE) as Promise<DuckDBModule>;
  return await duckdbModulePromise;
}

function unavailableMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class UnavailableSessionIndex implements SessionIndex {
  constructor(
    readonly dbPath: string,
    private readonly message: string,
  ) {}

  async status(): Promise<SessionIndexStatus> {
    return {
      ok: false,
      dbPath: this.dbPath,
      error: SESSION_INDEX_UNAVAILABLE,
      message: this.message,
    };
  }

  async catchUp(): Promise<SessionIndexStatus> {
    return this.status();
  }

  async rebuild(): Promise<SessionIndexStatus> {
    return this.status();
  }

  async querySessionDigests(): Promise<SessionIndexDigest[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listSessionDigests(): Promise<SessionIndexDigest[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async getSessionDigest(): Promise<SessionIndexDigest | undefined> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async filterSessionIdsByScope(): Promise<string[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async queryTapeEvidence(): Promise<SessionIndexTapeEvidence[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async getTapeEvent(): Promise<SessionIndexTapeEvidence | undefined> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listRecentSessions(): Promise<SessionIndexRecentSession[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listSessionBoxes(): Promise<SessionIndexBox[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listSessionRewindTargets(): Promise<SessionIndexRewindTarget[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listDelegationRuns(): Promise<SessionIndexDelegationRun[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listPendingDelegationOutcomes(): Promise<SessionIndexDelegationRun[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listWorkerResults(): Promise<SessionIndexWorkerResult[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async getParallelBudgetView(): Promise<SessionIndexParallelBudgetView> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async close(): Promise<void> {}
}

class DuckDBSessionIndex implements SessionIndex {
  readonly dbPath: string;
  private readonly workspaceRoot: string;
  private readonly readSnapshotPath: string | undefined;
  private readonly snapshotManifestPath: string;
  private readonly snapshotDir: string;
  private readonly connection: DuckDBConnection;
  private readonly events: SessionIndexEventSource;
  private readonly task: SessionIndexTaskSource;
  private readonly writerLease: WriteLease;
  private readonly instanceHandle: DuckDBInstanceHandle;
  private readonly unsubscribeFromEvents: (() => void) | undefined;
  private closed = false;
  private catchUpDirty = true;
  private lastCatchUpCheckedAt = 0;
  private lastCatchUpStatus: SessionIndexStatus | undefined;

  constructor(input: {
    workspaceRoot: string;
    dbPath: string;
    readSnapshotPath?: string;
    snapshotManifestPath: string;
    snapshotDir: string;
    connection: DuckDBConnection;
    events: SessionIndexEventSource;
    task: SessionIndexTaskSource;
    writerLease: WriteLease;
    instanceHandle: DuckDBInstanceHandle;
  }) {
    this.workspaceRoot = input.workspaceRoot;
    this.dbPath = input.dbPath;
    this.readSnapshotPath = input.readSnapshotPath;
    this.snapshotManifestPath = input.snapshotManifestPath;
    this.snapshotDir = input.snapshotDir;
    this.connection = input.connection;
    this.events = input.events;
    this.task = input.task;
    this.writerLease = input.writerLease;
    this.instanceHandle = input.instanceHandle;
    this.unsubscribeFromEvents = input.events.records.subscribe(() => {
      this.catchUpDirty = true;
    });
  }

  async initialize(): Promise<SessionIndexStatus> {
    try {
      if (this.writerLease.acquired) {
        await ensureSessionIndexSchema(this.connection);
      }
      return await this.status();
    } catch (error) {
      return {
        ok: false,
        dbPath: this.dbPath,
        error: SESSION_INDEX_UNAVAILABLE,
        message: unavailableMessage(error),
      };
    }
  }

  async status(): Promise<SessionIndexStatus> {
    try {
      const counts = await readSessionIndexStatusCounts(this.connection);
      return {
        ok: true,
        dbPath: this.dbPath,
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        writer: this.writerLease.acquired,
        indexedSessions: counts.indexedSessions,
        indexedEvents: counts.indexedEvents,
        ...(this.writerLease.acquired ? {} : { staleReason: "write_lease_unavailable" }),
        ...(this.readSnapshotPath ? { readSnapshotPath: this.readSnapshotPath } : {}),
        ...(counts.lastIndexedAt === undefined
          ? {}
          : {
              lastIndexedAt: counts.lastIndexedAt,
              indexAgeMs: Math.max(0, Date.now() - counts.lastIndexedAt),
            }),
      };
    } catch (error) {
      return {
        ok: false,
        dbPath: this.dbPath,
        error: SESSION_INDEX_UNAVAILABLE,
        message: unavailableMessage(error),
      };
    }
  }

  async catchUp(): Promise<SessionIndexStatus> {
    return await this.catchUpInternal(false);
  }

  async rebuild(): Promise<SessionIndexStatus> {
    if (!this.writerLease.acquired) {
      return {
        ok: false,
        dbPath: this.dbPath,
        error: SESSION_INDEX_UNAVAILABLE,
        message: "session index writer lease unavailable",
      };
    }
    try {
      await ensureSessionIndexSchema(this.connection);
      await clearSessionIndexRows(this.connection);
      this.catchUpDirty = true;
      this.lastCatchUpCheckedAt = 0;
      this.lastCatchUpStatus = undefined;
      return await this.catchUpInternal(true);
    } catch (error) {
      return {
        ok: false,
        dbPath: this.dbPath,
        error: SESSION_INDEX_UNAVAILABLE,
        message: unavailableMessage(error),
      };
    }
  }

  private async catchUpInternal(force: boolean): Promise<SessionIndexStatus> {
    if (!this.writerLease.acquired) {
      return await this.status();
    }
    const now = Date.now();
    if (
      !force &&
      !this.catchUpDirty &&
      this.lastCatchUpStatus &&
      now - this.lastCatchUpCheckedAt < CATCH_UP_DEBOUNCE_MS
    ) {
      return this.lastCatchUpStatus;
    }

    try {
      await ensureSessionIndexSchema(this.connection);
      let changed = !resolvePublishedReadSnapshotPath({
        manifestPath: this.snapshotManifestPath,
        snapshotDir: this.snapshotDir,
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      });
      const sessionIds = uniqueNonEmptyStrings([
        ...this.events.log.listSessionIds(),
        ...(await listIndexedSessionIds(this.connection)),
      ]);
      for (const sessionId of sessionIds) {
        changed = (await this.indexSession(sessionId)) || changed;
      }
      if (changed) {
        await this.publishReadSnapshot();
      }
      const status = await this.status();
      this.lastCatchUpStatus = status;
      this.lastCatchUpCheckedAt = Date.now();
      this.catchUpDirty = false;
      return status;
    } catch (error) {
      return {
        ok: false,
        dbPath: this.dbPath,
        error: SESSION_INDEX_UNAVAILABLE,
        message: unavailableMessage(error),
      };
    }
  }

  async querySessionDigests(input: QuerySessionDigestsInput): Promise<SessionIndexDigest[]> {
    return await querySessionDigestRows({
      query: input,
      workspaceRoot: this.workspaceRoot,
      port: this.queryPort(),
    });
  }

  async listSessionDigests(input: ListSessionDigestsInput = {}): Promise<SessionIndexDigest[]> {
    return await listSessionDigestRows({
      query: input,
      port: this.queryPort(),
    });
  }

  async getSessionDigest(input: { sessionId: string }): Promise<SessionIndexDigest | undefined> {
    return await getSessionDigestRow({
      sessionId: input.sessionId,
      port: this.queryPort(),
    });
  }

  async filterSessionIdsByScope(input: FilterSessionIdsByScopeInput): Promise<string[]> {
    return await filterScopedSessionIds({
      query: input,
      workspaceRoot: this.workspaceRoot,
      port: this.queryPort(),
    });
  }

  async queryTapeEvidence(input: QueryTapeEvidenceInput): Promise<SessionIndexTapeEvidence[]> {
    return await queryTapeEvidenceRows({
      query: input,
      port: this.queryPort(),
    });
  }

  async getTapeEvent(input: {
    sessionId: string;
    eventId: string;
  }): Promise<SessionIndexTapeEvidence | undefined> {
    return await getTapeEventRow({
      sessionId: input.sessionId,
      eventId: input.eventId,
      port: this.queryPort(),
    });
  }

  async listRecentSessions(input: QueryRecentSessionsInput): Promise<SessionIndexRecentSession[]> {
    return await listRecentSessionRows({
      query: input,
      port: this.queryPort(),
    });
  }

  async listSessionBoxes(input: { sessionId?: string } = {}): Promise<SessionIndexBox[]> {
    return await listProjectedSessionBoxes({
      sessionId: input.sessionId,
      port: this.queryPort(),
    });
  }

  async listSessionRewindTargets(input: {
    sessionId: string;
  }): Promise<SessionIndexRewindTarget[]> {
    return await listProjectedSessionRewindTargets({
      sessionId: input.sessionId,
      port: this.queryPort(),
    });
  }

  async listDelegationRuns(
    input: {
      sessionId?: string;
      includeTerminal?: boolean;
      limit?: number;
    } = {},
  ): Promise<SessionIndexDelegationRun[]> {
    return await listDelegationRunRows({
      ...input,
      port: this.queryPort(),
    });
  }

  async listPendingDelegationOutcomes(input: {
    sessionId: string;
    limit?: number;
  }): Promise<SessionIndexDelegationRun[]> {
    return await listPendingDelegationOutcomeRows({
      ...input,
      port: this.queryPort(),
    });
  }

  async listWorkerResults(
    input: {
      sessionId?: string;
      limit?: number;
    } = {},
  ): Promise<SessionIndexWorkerResult[]> {
    return await listWorkerResultRows({
      ...input,
      port: this.queryPort(),
    });
  }

  async getParallelBudgetView(input: {
    sessionId: string;
  }): Promise<SessionIndexParallelBudgetView> {
    return await getParallelBudgetViewRow({
      ...input,
      port: this.queryPort(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.connection.closeSync();
    } finally {
      this.unsubscribeFromEvents?.();
      this.writerLease.release();
      this.instanceHandle.release();
    }
  }

  private queryPort(): SessionIndexQueryPort {
    return {
      ensureAvailable: async () => {
        await this.ensureAvailable();
      },
      selectOne: async <T extends JsonRow>(sql: string, values?: SqlParams) =>
        await selectOne<T>(this.connection, sql, values),
      selectRows: async <T extends JsonRow>(sql: string, values?: SqlParams) =>
        await selectRows<T>(this.connection, sql, values),
    };
  }

  private async ensureAvailable(): Promise<void> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
  }

  private async indexSession(sessionId: string): Promise<boolean> {
    const logPath = this.events.log.getPath(sessionId);
    const previous = await readIndexedSessionState(this.connection, sessionId);
    let stat: Stats;
    try {
      stat = statSync(logPath);
    } catch {
      if (previous) {
        await deleteSessionRows(this.connection, sessionId);
        return true;
      }
      return false;
    }
    const previousOffset = previous?.byteOffset ?? 0;
    const reset = previousOffset > stat.size;
    const offset = reset ? 0 : previousOffset;
    const readResult = readEventsFromLog(logPath, sessionId, offset);
    if (!reset && readResult.events.length === 0 && readResult.nextOffset === offset) {
      return false;
    }

    return await runSessionIndexTransaction(this.connection, async () => {
      if (reset) {
        await deleteSessionRows(this.connection, sessionId);
      }
      await upsertSessionEvents({
        connection: this.connection,
        logPath,
        parsedEvents: readResult.events,
      });
      await rebuildSessionProjection({
        connection: this.connection,
        workspaceRoot: this.workspaceRoot,
        task: this.task,
        sessionId,
        logPath,
        stat,
        byteOffset: readResult.nextOffset,
      });
      return true;
    });
  }

  private async publishReadSnapshot(): Promise<void> {
    await checkpointSessionIndex(this.connection);
    mkdirSync(this.snapshotDir, { recursive: true });

    const publishedAt = Date.now();
    const snapshotFile = `session-index-${publishedAt}-${process.pid}-${Math.random()
      .toString(16)
      .slice(2)}.duckdb`;
    const tempPath = join(this.snapshotDir, `${snapshotFile}.tmp`);
    const snapshotPath = join(this.snapshotDir, snapshotFile);

    rmSync(tempPath, { force: true });
    copyFileSync(this.dbPath, tempPath);
    renameSync(tempPath, snapshotPath);

    const status = await this.status();
    const manifest: ReadSnapshotManifest = {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      snapshotFile,
      publishedAt,
      writerPid: process.pid,
      indexedSessions: status.ok ? status.indexedSessions : 0,
      indexedEvents: status.ok ? status.indexedEvents : 0,
    };
    writeReadSnapshotManifest(this.snapshotManifestPath, manifest);
    pruneReadSnapshots(this.snapshotDir, snapshotFile);
  }
}
