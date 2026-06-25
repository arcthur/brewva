import { mkdirSync } from "node:fs";
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
  type SessionIndexHarnessPatternCandidate,
  type SessionIndexHarnessTraceSnapshot,
  type SessionIndexParallelBudgetView,
  type SessionIndexRecentSession,
  type SessionIndexRewindTarget,
  type SessionIndexStatus,
  type SessionIndexTapeEvidence,
  type SessionIndexTaskSource,
  type SessionIndexWorkerResult,
} from "./api.js";
import { acquireWriteLease, type WriteLease } from "./lease/write-lease.js";
import { listSessionBoxes as listProjectedSessionBoxes } from "./projection/box.js";
import {
  getParallelBudgetViewRow,
  listDelegationRunRows,
  listPendingDelegationOutcomeRows,
  listWorkerResultRows,
} from "./projection/delegation.js";
import { upsertSessionEvents } from "./projection/events.js";
import {
  getHarnessTraceSnapshotRow,
  listHarnessPatternCandidateRows,
  listHarnessTraceSnapshotRows,
} from "./projection/harness.js";
import { listSessionRewindTargets as listProjectedSessionRewindTargets } from "./projection/rewind.js";
import { rebuildSessionProjection } from "./projection/session.js";
import {
  filterScopedSessionIds,
  getSessionDigestRow,
  listSessionDigestRows,
  querySessionDigestRows,
} from "./query/digests.js";
import { type SessionIndexQueryPort } from "./query/port.js";
import type { JsonRow } from "./query/port.js";
import {
  getTapeEventRow,
  listRecentSessionRows,
  queryTapeEvidenceRows,
} from "./query/tape-evidence.js";
import { type SqlParams } from "./sql/params.js";
import {
  acquireSqliteInstance,
  type SqliteConnection,
  type SqliteInstanceHandle,
} from "./sqlite/instance.js";
import {
  checkpointSessionIndex,
  deleteSessionRows,
  ensureSessionIndexSchema,
  hasSchemaMismatch,
  listIndexedSessionIds,
  readIndexedSessionState,
  readSessionIndexStatusCounts,
  runSessionIndexTransaction,
} from "./sqlite/lifecycle.js";
import { selectOne, selectRows } from "./sqlite/query.js";
import { SESSION_INDEX_UNAVAILABLE, SessionIndexUnavailableError } from "./unavailable.js";

const DEFAULT_DB_RELATIVE_PATH = join(".brewva", "session-index", "session-index.sqlite");
const DEFAULT_LOCK_RELATIVE_PATH = join(".brewva", "session-index", "write.lock");
const CATCH_UP_DEBOUNCE_MS = 5_000;

export async function createSessionIndex(input: CreateSessionIndexInput): Promise<SessionIndex> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const dbPath = resolve(input.dbPath ?? join(workspaceRoot, DEFAULT_DB_RELATIVE_PATH));
  mkdirSync(dirname(dbPath), { recursive: true });

  // Writer election: the writer opens read-write and establishes WAL; every
  // non-writer opens the SAME db read-only and reads the live WAL (snapshot
  // isolation), so there is no physical reader-snapshot copy to publish anymore.
  const lease = acquireWriteLease(resolve(join(workspaceRoot, DEFAULT_LOCK_RELATIVE_PATH)));
  let instanceHandle: SqliteInstanceHandle | undefined;
  try {
    instanceHandle = acquireSqliteInstance(dbPath, !lease.acquired);
    const index = new SqliteSessionIndex({
      workspaceRoot,
      dbPath,
      connection: instanceHandle.connection,
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

  async listHarnessTraceSnapshots(): Promise<SessionIndexHarnessTraceSnapshot[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async getHarnessTraceSnapshot(): Promise<SessionIndexHarnessTraceSnapshot | undefined> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async listHarnessPatternCandidates(): Promise<SessionIndexHarnessPatternCandidate[]> {
    throw new SessionIndexUnavailableError(this.message);
  }

  async close(): Promise<void> {}
}

class SqliteSessionIndex implements SessionIndex {
  readonly dbPath: string;
  private readonly workspaceRoot: string;
  private readonly connection: SqliteConnection;
  private readonly events: SessionIndexEventSource;
  private readonly task: SessionIndexTaskSource;
  private readonly writerLease: WriteLease;
  private readonly instanceHandle: SqliteInstanceHandle;
  private readonly unsubscribeFromEvents: (() => void) | undefined;
  private closed = false;
  private catchUpDirty = true;
  private lastCatchUpCheckedAt = 0;
  private lastCatchUpStatus: SessionIndexStatus | undefined;
  // Serializes writer transactions. Every public query enters via
  // ensureAvailable() -> catchUp(); without this gate two concurrent queries both
  // pass the synchronous debounce, both issue BEGIN on the shared single
  // connection, and the second throws "cannot start a transaction within a
  // transaction". The write lease is per-process, not per-call — query methods are
  // independently awaitable. catchUp callers coalesce onto the in-flight run;
  // rebuild serializes after it.
  private writerInFlight: Promise<SessionIndexStatus> | undefined;

  constructor(input: {
    workspaceRoot: string;
    dbPath: string;
    connection: SqliteConnection;
    events: SessionIndexEventSource;
    task: SessionIndexTaskSource;
    writerLease: WriteLease;
    instanceHandle: SqliteInstanceHandle;
  }) {
    this.workspaceRoot = input.workspaceRoot;
    this.dbPath = input.dbPath;
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
    if (this.writerInFlight) {
      return await this.writerInFlight;
    }
    this.writerInFlight = this.catchUpInternal().finally(() => {
      this.writerInFlight = undefined;
    });
    return await this.writerInFlight;
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
    // Serialize behind any in-flight catch-up so the two never overlap a BEGIN on
    // the shared connection (same writer gate as catchUp). rebuild has no
    // production callers and is operator-initiated, so it is not expected to race
    // another rebuild.
    while (this.writerInFlight) {
      await this.writerInFlight.catch(() => {});
    }
    this.writerInFlight = this.rebuildInternal().finally(() => {
      this.writerInFlight = undefined;
    });
    return await this.writerInFlight;
  }

  private async rebuildInternal(): Promise<SessionIndexStatus> {
    try {
      await ensureSessionIndexSchema(this.connection);
      // RFC posture A: a full rebuild clears and reprojects every session inside
      // ONE transaction, so concurrent read-only handles keep seeing the prior
      // WAL snapshot until the single commit flips them to the rebuilt index.
      await this.fullRebuildInTransaction();
      await checkpointSessionIndex(this.connection);
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

  private async catchUpInternal(): Promise<SessionIndexStatus> {
    if (!this.writerLease.acquired) {
      return await this.status();
    }
    const now = Date.now();
    if (
      !this.catchUpDirty &&
      this.lastCatchUpStatus &&
      now - this.lastCatchUpCheckedAt < CATCH_UP_DEBOUNCE_MS
    ) {
      return this.lastCatchUpStatus;
    }

    try {
      await ensureSessionIndexSchema(this.connection);
      // A schema-version bump needs a full rebuild; take it inside ONE transaction
      // (RFC posture A) so concurrent read-only handles never see a cleared or
      // half-rebuilt index — the same publish barrier rebuild() uses. Steady-state
      // catch-up stays per-session incremental (small, frequent transactions).
      if (await hasSchemaMismatch(this.connection)) {
        await this.fullRebuildInTransaction();
        await checkpointSessionIndex(this.connection);
      } else {
        const sessionIds = uniqueNonEmptyStrings([
          ...this.events.records.listSessionIds(),
          ...(await listIndexedSessionIds(this.connection)),
        ]);
        for (const sessionId of sessionIds) {
          await this.indexSession(sessionId);
        }
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

  async listHarnessTraceSnapshots(
    input: {
      sessionId?: string;
      limit?: number;
    } = {},
  ): Promise<SessionIndexHarnessTraceSnapshot[]> {
    return await listHarnessTraceSnapshotRows({
      ...input,
      port: this.queryPort(),
    });
  }

  async getHarnessTraceSnapshot(input: {
    snapshotId: string;
  }): Promise<SessionIndexHarnessTraceSnapshot | undefined> {
    return await getHarnessTraceSnapshotRow({
      ...input,
      port: this.queryPort(),
    });
  }

  async listHarnessPatternCandidates(
    input: {
      sessionId?: string;
      minOccurrences?: number;
      limit?: number;
    } = {},
  ): Promise<SessionIndexHarnessPatternCandidate[]> {
    return await listHarnessPatternCandidateRows({
      ...input,
      port: this.queryPort(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // The connection is the ref-counted cached Database; releasing the handle
    // closes it when the last reference drops. Do not close it directly.
    this.unsubscribeFromEvents?.();
    this.writerLease.release();
    this.instanceHandle.release();
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

  /**
   * Clear and reproject every session inside ONE transaction. Reads inside the
   * transaction see the in-progress deletes (so each session reprojects fresh),
   * and concurrent read-only handles keep the previous WAL snapshot until commit.
   */
  private async fullRebuildInTransaction(): Promise<void> {
    const indexedIds = await listIndexedSessionIds(this.connection);
    const sessionIds = uniqueNonEmptyStrings([
      ...this.events.records.listSessionIds(),
      ...indexedIds,
    ]);
    await runSessionIndexTransaction(this.connection, async () => {
      for (const sessionId of indexedIds) {
        await deleteSessionRows(this.connection, sessionId);
      }
      for (const sessionId of sessionIds) {
        await this.indexSession(sessionId, { inline: true });
      }
    });
  }

  private async indexSession(
    sessionId: string,
    options: { inline?: boolean } = {},
  ): Promise<boolean> {
    const sourceUri = `canonical-tape:${sessionId}`;
    const records = this.events.records.list(sessionId);
    const previous = await readIndexedSessionState(this.connection, sessionId);
    if (records.length === 0) {
      if (previous) {
        await deleteSessionRows(this.connection, sessionId);
        return true;
      }
      return false;
    }
    if (previous?.indexedEventCount === records.length) {
      return false;
    }
    const reset = !previous || previous.indexedEventCount > records.length;
    const newEvents = reset ? records : records.slice(previous.indexedEventCount);
    const parsedEvents = newEvents.map((event, index) => ({
      event,
      sequence: reset ? index : previous.indexedEventCount + index,
    }));

    const work = async (): Promise<boolean> => {
      if (reset) {
        await deleteSessionRows(this.connection, sessionId);
      }
      await upsertSessionEvents({
        connection: this.connection,
        sourceUri,
        parsedEvents,
      });
      await rebuildSessionProjection({
        connection: this.connection,
        workspaceRoot: this.workspaceRoot,
        task: this.task,
        sessionId,
        sourceUri,
        sourceCursor: records.length,
      });
      return true;
    };

    // When the caller already owns a transaction (full rebuild), run inline:
    // SQLite forbids nested BEGIN, and the outer commit is the publish barrier.
    return options.inline ? await work() : await runSessionIndexTransaction(this.connection, work);
  }
}
