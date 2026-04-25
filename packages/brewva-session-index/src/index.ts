import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaStructuredEvent,
} from "@brewva/brewva-runtime";
import { tokenizeSearchText } from "@brewva/brewva-search";

export const SESSION_INDEX_SCHEMA_VERSION = 1;
export const SESSION_INDEX_UNAVAILABLE = "session_index_unavailable" as const;

const DEFAULT_DB_RELATIVE_PATH = join(".brewva", "session-index", "session-index.duckdb");
const DEFAULT_LOCK_RELATIVE_PATH = join(".brewva", "session-index", "write.lock");
const DEFAULT_SNAPSHOT_MANIFEST_RELATIVE_PATH = join(
  ".brewva",
  "session-index",
  "read-snapshot.json",
);
const DEFAULT_SNAPSHOT_DIR_RELATIVE_PATH = join(".brewva", "session-index", "snapshots");
const DUCKDB_NODE_API_PACKAGE = ["@duckdb", "node-api"].join("/");
const MAX_DIGEST_SNIPPETS = 20;
const SNAPSHOT_KEEP_COUNT = 3;
const CATCH_UP_DEBOUNCE_MS = 5_000;
const WRITE_LEASE_HEARTBEAT_MS = 30_000;
const WRITE_LEASE_STALE_MS = 10 * 60_000;
const LOG_READ_CHUNK_BYTES = 64 * 1024;

export type SessionIndexScope = "session_local" | "user_repository_root" | "workspace_wide";

export interface SessionIndexEventSource {
  listSessionIds(): string[];
  list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  getLogPath(sessionId: string): string;
  subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
}

export interface SessionIndexTaskSource {
  getTargetDescriptor(sessionId: string): {
    primaryRoot?: string;
    roots?: string[];
  };
}

export interface SessionIndexDigest {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
  repositoryRoot: string;
  primaryRoot: string;
  targetRoots: string[];
  taskGoal?: string;
  digestText: string;
  tokenScore: number;
}

export interface SessionIndexTapeEvidence {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
  type: string;
  payload: Record<string, unknown>;
  searchText: string;
  logPath: string;
  logOffset: number;
  tokenScore: number;
}

export interface QuerySessionDigestsInput {
  currentSessionId: string;
  scope: SessionIndexScope;
  targetRoots: readonly string[];
  queryTokens: readonly string[];
  limit: number;
}

export interface QueryTapeEvidenceInput {
  sessionIds: readonly string[];
  queryTokens: readonly string[];
  limit: number;
}

export interface QueryRecentSessionsInput {
  limit: number;
}

export interface FilterSessionIdsByScopeInput {
  currentSessionId: string;
  scope: SessionIndexScope;
  targetRoots: readonly string[];
  sessionIds: readonly string[];
}

export interface ListSessionDigestsInput {
  limit?: number;
}

export interface SessionIndexRecentSession {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface SessionIndexBox {
  sessionId: string;
  boxId: string;
  image: string;
  createdAt: number;
  lastExecAt: number;
  fingerprint?: string;
  snapshotRefs: string[];
}

export type SessionIndexStatus =
  | {
      ok: true;
      dbPath: string;
      schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
      writer: boolean;
      indexedSessions: number;
      indexedEvents: number;
      staleReason?: string;
      readSnapshotPath?: string;
      lastIndexedAt?: number;
      indexAgeMs?: number;
    }
  | {
      ok: false;
      dbPath: string;
      error: typeof SESSION_INDEX_UNAVAILABLE;
      message: string;
    };

export interface SessionIndex {
  readonly dbPath: string;
  status(): Promise<SessionIndexStatus>;
  catchUp(): Promise<SessionIndexStatus>;
  rebuild(): Promise<SessionIndexStatus>;
  querySessionDigests(input: QuerySessionDigestsInput): Promise<SessionIndexDigest[]>;
  listSessionDigests(input?: ListSessionDigestsInput): Promise<SessionIndexDigest[]>;
  getSessionDigest(input: { sessionId: string }): Promise<SessionIndexDigest | undefined>;
  filterSessionIdsByScope(input: FilterSessionIdsByScopeInput): Promise<string[]>;
  queryTapeEvidence(input: QueryTapeEvidenceInput): Promise<SessionIndexTapeEvidence[]>;
  getTapeEvent(input: {
    sessionId: string;
    eventId: string;
  }): Promise<SessionIndexTapeEvidence | undefined>;
  listRecentSessions(input: QueryRecentSessionsInput): Promise<SessionIndexRecentSession[]>;
  listSessionBoxes(input?: { sessionId?: string }): Promise<SessionIndexBox[]>;
  close(): Promise<void>;
}

export interface CreateSessionIndexInput {
  workspaceRoot: string;
  events: SessionIndexEventSource;
  task: SessionIndexTaskSource;
  dbPath?: string;
}

type DuckDBModule = typeof import("@duckdb/node-api");
type DuckDBConnection = import("@duckdb/node-api").DuckDBConnection;
type DuckDBInstance = import("@duckdb/node-api").DuckDBInstance;

type JsonRow = object;

interface ParsedLogEvent {
  event: BrewvaEventRecord;
  logOffset: number;
}

interface ReadLogResult {
  events: ParsedLogEvent[];
  nextOffset: number;
}

interface IndexStateRow {
  byte_offset?: bigint | number;
  indexed_event_count?: number;
}

interface SessionIdRow {
  session_id: string;
}

interface StatusRow {
  indexed_sessions: bigint | number;
  indexed_events: bigint | number;
  last_indexed_at?: number | null;
}

interface ReadSnapshotManifest {
  schemaVersion: typeof SESSION_INDEX_SCHEMA_VERSION;
  snapshotFile: string;
  publishedAt: number;
  writerPid: number;
  indexedSessions: number;
  indexedEvents: number;
}

interface EventRow {
  event_id: string;
  session_id: string;
  timestamp: number;
  turn: number | null;
  type: string;
  payload_json: string;
  search_text: string;
  log_path: string;
  log_offset: bigint | number;
}

interface IndexedEventInsertRow {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn: number | null;
  type: string;
  payloadJson: string;
  searchText: string;
  logPath: string;
  logOffset: number;
}

interface IndexedEventTokenInsertRow {
  token: string;
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: number;
}

type SqlValue = string | number | null;
type SqlParams = Record<string, SqlValue>;

interface SessionRow {
  session_id: string;
  event_count: number;
  last_event_at: number;
  repository_root: string;
  primary_root: string;
  target_roots_json: string;
  task_goal: string | null;
  digest_text: string;
  token_matches?: bigint | number;
}

interface SessionBoxRow {
  session_id: string;
  box_id: string;
  image: string;
  created_at: number;
  last_exec_at: number;
  fingerprint: string | null;
  snapshot_refs_json: string;
}

let duckdbModulePromise: Promise<DuckDBModule> | undefined;
const instanceCache = new Map<string, CachedDuckDBInstance>();

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
    : resolvePublishedReadSnapshotPath(snapshotManifestPath, snapshotDir);
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

  async close(): Promise<void> {}
}

export class SessionIndexUnavailableError extends Error {
  readonly code = SESSION_INDEX_UNAVAILABLE;

  constructor(message: string) {
    super(message);
    this.name = "SessionIndexUnavailableError";
  }
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
    this.unsubscribeFromEvents = input.events.subscribe(() => {
      this.catchUpDirty = true;
    });
  }

  async initialize(): Promise<SessionIndexStatus> {
    try {
      if (this.writerLease.acquired) {
        await this.createSchema();
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
      const counts = await this.selectOne<StatusRow>(
        `
          select
            (select count(*) from sessions) as indexed_sessions,
            (select count(*) from events) as indexed_events,
            (select max(last_indexed_at) from index_state) as last_indexed_at
        `,
      );
      const lastIndexedAt =
        typeof counts?.last_indexed_at === "number" && Number.isFinite(counts.last_indexed_at)
          ? counts.last_indexed_at
          : undefined;
      return {
        ok: true,
        dbPath: this.dbPath,
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        writer: this.writerLease.acquired,
        indexedSessions: Number(counts?.indexed_sessions ?? 0),
        indexedEvents: Number(counts?.indexed_events ?? 0),
        ...(this.writerLease.acquired ? {} : { staleReason: "write_lease_unavailable" }),
        ...(this.readSnapshotPath ? { readSnapshotPath: this.readSnapshotPath } : {}),
        ...(lastIndexedAt === undefined
          ? {}
          : { lastIndexedAt, indexAgeMs: Math.max(0, Date.now() - lastIndexedAt) }),
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
      await this.createSchema();
      await this.clearIndexRows();
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
      await this.createSchema();
      let changed = !resolvePublishedReadSnapshotPath(this.snapshotManifestPath, this.snapshotDir);
      const sessionIds = uniqueStrings([
        ...this.events.listSessionIds(),
        ...(await this.listIndexedSessionIds()),
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
    const queryTokens = uniqueStrings(input.queryTokens);
    if (queryTokens.length === 0) {
      return [];
    }
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);

    const targetRoots = normalizeRoots(input.targetRoots, this.workspaceRoot);
    const params: SqlParams = {
      currentSessionId: input.currentSessionId,
      limit: Math.max(1, Math.trunc(input.limit)),
    };
    const tokenFilter = buildInList("token", queryTokens, params);
    const scopeFilter = this.buildScopeSql(input.scope, targetRoots, params);
    const tokenMatchesExpression =
      queryTokens.length > 0 ? "coalesce(token_scores.token_matches, 0)" : "cast(0 as integer)";
    const tokenJoin =
      queryTokens.length > 0
        ? `
          left join (
            select session_id, count(distinct token) as token_matches
            from session_tokens
            where token in (${tokenFilter})
            group by session_id
          ) token_scores on token_scores.session_id = sessions.session_id
        `
        : "";
    const rows = await this.selectRows<SessionRow>(
      `
        select
          sessions.session_id,
          sessions.event_count,
          sessions.last_event_at,
          sessions.repository_root,
          sessions.primary_root,
          sessions.target_roots_json,
          sessions.task_goal,
          sessions.digest_text,
          ${tokenMatchesExpression} as token_matches
        from sessions
        ${tokenJoin}
        where ${scopeFilter}
          and (${tokenMatchesExpression} > 0 or sessions.session_id = $currentSessionId)
        order by
          ${tokenMatchesExpression} desc,
          case when sessions.session_id = $currentSessionId then 1 else 0 end desc,
          sessions.last_event_at desc
        limit $limit
      `,
      params,
    );

    const denominator = Math.max(1, queryTokens.length);
    return rows.map((row) => mapSessionRow(row, Number(row.token_matches ?? 0) / denominator));
  }

  async listSessionDigests(input: ListSessionDigestsInput = {}): Promise<SessionIndexDigest[]> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
    const limit = input.limit ? Math.max(1, Math.trunc(input.limit)) : 1_000_000;
    const rows = await this.selectRows<SessionRow>(
      `
        select
          session_id,
          event_count,
          last_event_at,
          repository_root,
          primary_root,
          target_roots_json,
          task_goal,
          digest_text,
          0 as token_matches
        from sessions
        order by last_event_at desc
        limit $limit
      `,
      { limit },
    );
    return rows.map((row) => mapSessionRow(row, 0));
  }

  async getSessionDigest(input: { sessionId: string }): Promise<SessionIndexDigest | undefined> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
    const row = await this.selectOne<SessionRow>(
      `
        select
          session_id,
          event_count,
          last_event_at,
          repository_root,
          primary_root,
          target_roots_json,
          task_goal,
          digest_text,
          0 as token_matches
        from sessions
        where session_id = $sessionId
        limit 1
      `,
      { sessionId: input.sessionId },
    );
    return row ? mapSessionRow(row, 0) : undefined;
  }

  async filterSessionIdsByScope(input: FilterSessionIdsByScopeInput): Promise<string[]> {
    const sessionIds = uniqueStrings(input.sessionIds);
    if (sessionIds.length === 0) return [];

    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);

    const targetRoots = normalizeRoots(input.targetRoots, this.workspaceRoot);
    const params: SqlParams = {};
    if (input.scope === "session_local") {
      params.currentSessionId = input.currentSessionId;
    }
    const sessionFilter = buildInList("session", sessionIds, params);
    const scopeFilter = this.buildScopeSql(input.scope, targetRoots, params);
    const rows = await this.selectRows<SessionIdRow>(
      `
        select sessions.session_id
        from sessions
        where sessions.session_id in (${sessionFilter})
          and ${scopeFilter}
      `,
      params,
    );
    return rows.map((row) => row.session_id);
  }

  async queryTapeEvidence(input: QueryTapeEvidenceInput): Promise<SessionIndexTapeEvidence[]> {
    const sessionIds = uniqueStrings(input.sessionIds);
    const queryTokens = uniqueStrings(input.queryTokens);
    if (sessionIds.length === 0 || queryTokens.length === 0) return [];

    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);

    const params: SqlParams = {
      limit: Math.max(1, Math.trunc(input.limit)),
    };
    const sessionFilter = buildInList("session", sessionIds, params);
    const tokenFilter = buildInList("token", queryTokens, params);
    const rows = await this.selectRows<EventRow & { token_matches: bigint | number }>(
      `
        select
          events.event_id,
          events.session_id,
          events.timestamp,
          events.turn,
          events.type,
          events.payload_json,
          events.search_text,
          events.log_path,
          events.log_offset,
          count(distinct event_tokens.token) as token_matches
        from event_tokens
        inner join events on events.event_id = event_tokens.event_id
        where event_tokens.session_id in (${sessionFilter})
          and event_tokens.token in (${tokenFilter})
        group by
          events.event_id,
          events.session_id,
          events.timestamp,
          events.turn,
          events.type,
          events.payload_json,
          events.search_text,
          events.log_path,
          events.log_offset
        order by token_matches desc, events.timestamp desc
        limit $limit
      `,
      params,
    );
    const denominator = Math.max(1, queryTokens.length);
    return rows.map((row) => mapEventRow(row, Number(row.token_matches ?? 0) / denominator));
  }

  async getTapeEvent(input: {
    sessionId: string;
    eventId: string;
  }): Promise<SessionIndexTapeEvidence | undefined> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
    const row = await this.selectOne<EventRow>(
      `
        select event_id, session_id, timestamp, turn, type, payload_json, search_text, log_path, log_offset
        from events
        where session_id = $sessionId and event_id = $eventId
        limit 1
      `,
      {
        sessionId: input.sessionId,
        eventId: input.eventId,
      },
    );
    return row ? mapEventRow(row, 0) : undefined;
  }

  async listRecentSessions(input: QueryRecentSessionsInput): Promise<SessionIndexRecentSession[]> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
    const rows = await this.selectRows<{
      session_id: string;
      event_count: number;
      last_event_at: number;
    }>(
      `
        select session_id, event_count, last_event_at
        from sessions
        order by last_event_at desc
        limit $limit
      `,
      { limit: Math.max(1, Math.trunc(input.limit)) },
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      eventCount: row.event_count,
      lastEventAt: row.last_event_at,
    }));
  }

  async listSessionBoxes(input: { sessionId?: string } = {}): Promise<SessionIndexBox[]> {
    const status = await this.catchUp();
    if (!status.ok) throw new SessionIndexUnavailableError(status.message);
    const rows = await this.selectRows<SessionBoxRow>(
      input.sessionId
        ? `
          select session_id, box_id, image, created_at, last_exec_at, fingerprint, snapshot_refs_json
          from session_box
          where session_id = $sessionId
          order by last_exec_at desc
        `
        : `
          select session_id, box_id, image, created_at, last_exec_at, fingerprint, snapshot_refs_json
          from session_box
          order by last_exec_at desc
        `,
      input.sessionId ? { sessionId: input.sessionId } : {},
    );
    return rows.map(mapSessionBoxRow);
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

  private async createSchema(): Promise<void> {
    await this.connection.run(`
      create table if not exists sessions (
        session_id varchar primary key,
        repository_root varchar not null,
        primary_root varchar not null,
        target_roots_json varchar not null,
        task_goal varchar,
        digest_text varchar not null,
        event_count integer not null,
        last_event_at double not null
      );

      create table if not exists session_target_roots (
        session_id varchar not null,
        target_root varchar not null
      );

      create table if not exists session_box (
        session_id varchar primary key,
        box_id varchar not null,
        image varchar not null,
        created_at double not null,
        last_exec_at double not null,
        fingerprint varchar,
        snapshot_refs_json varchar not null
      );

      create table if not exists events (
        event_id varchar primary key,
        session_id varchar not null,
        timestamp double not null,
        turn integer,
        type varchar not null,
        payload_json varchar not null,
        search_text varchar not null,
        log_path varchar not null,
        log_offset bigint not null
      );

      create table if not exists event_tokens (
        token varchar not null,
        event_id varchar not null,
        session_id varchar not null,
        type varchar not null,
        timestamp double not null
      );

      create table if not exists session_tokens (
        token varchar not null,
        session_id varchar not null,
        source_field varchar not null
      );

      create table if not exists index_state (
        session_id varchar primary key,
        log_path varchar not null,
        byte_offset bigint not null,
        mtime_ms double not null,
        indexed_event_count integer not null,
        last_indexed_at double not null,
        status varchar not null,
        schema_version integer not null
      );

      create index if not exists session_target_roots_session_idx
        on session_target_roots(session_id);
      create index if not exists session_target_roots_root_idx
        on session_target_roots(target_root);
      create index if not exists session_box_box_idx
        on session_box(box_id);
      create index if not exists event_tokens_token_idx
        on event_tokens(token);
      create index if not exists event_tokens_session_idx
        on event_tokens(session_id);
      create index if not exists session_tokens_token_idx
        on session_tokens(token);
      create index if not exists session_tokens_session_idx
        on session_tokens(session_id);
      create index if not exists events_session_idx
        on events(session_id);
    `);
  }

  private async indexSession(sessionId: string): Promise<boolean> {
    const logPath = this.events.getLogPath(sessionId);
    const previous = await this.selectOne<IndexStateRow>(
      "select byte_offset, indexed_event_count from index_state where session_id = $sessionId",
      { sessionId },
    );
    let stat: Stats;
    try {
      stat = statSync(logPath);
    } catch {
      if (previous) {
        await this.deleteSessionRows(sessionId);
        return true;
      }
      return false;
    }
    const previousOffset = Number(previous?.byte_offset ?? 0);
    const reset = previousOffset > stat.size;
    const offset = reset ? 0 : previousOffset;
    const readResult = readEventsFromLog(logPath, sessionId, offset);
    if (!reset && readResult.events.length === 0 && readResult.nextOffset === offset) {
      return false;
    }

    await this.connection.run("begin transaction");
    try {
      if (reset) {
        await this.deleteSessionRows(sessionId);
      }
      await this.upsertEvents(logPath, readResult.events);
      await this.rebuildSessionProjection(sessionId, logPath, stat, readResult.nextOffset);
      await this.connection.run("commit");
      return true;
    } catch (error) {
      await this.connection.run("rollback");
      throw error;
    }
  }

  private async deleteSessionRows(sessionId: string): Promise<void> {
    await this.connection.run("delete from event_tokens where session_id = $sessionId", {
      sessionId,
    });
    await this.connection.run("delete from session_tokens where session_id = $sessionId", {
      sessionId,
    });
    await this.connection.run("delete from session_target_roots where session_id = $sessionId", {
      sessionId,
    });
    await this.connection.run("delete from session_box where session_id = $sessionId", {
      sessionId,
    });
    await this.connection.run("delete from events where session_id = $sessionId", { sessionId });
    await this.connection.run("delete from sessions where session_id = $sessionId", { sessionId });
    await this.connection.run("delete from index_state where session_id = $sessionId", {
      sessionId,
    });
  }

  private async listIndexedSessionIds(): Promise<string[]> {
    const rows = await this.selectRows<SessionIdRow>("select session_id from index_state");
    return rows.map((row) => row.session_id);
  }

  private async clearIndexRows(): Promise<void> {
    await this.connection.run("begin transaction");
    try {
      await this.connection.run("delete from event_tokens");
      await this.connection.run("delete from session_tokens");
      await this.connection.run("delete from session_target_roots");
      await this.connection.run("delete from session_box");
      await this.connection.run("delete from events");
      await this.connection.run("delete from sessions");
      await this.connection.run("delete from index_state");
      await this.connection.run("commit");
    } catch (error) {
      await this.connection.run("rollback");
      throw error;
    }
  }

  private async upsertEvents(
    logPath: string,
    parsedEvents: readonly ParsedLogEvent[],
  ): Promise<void> {
    if (parsedEvents.length === 0) return;
    const eventRows: IndexedEventInsertRow[] = [];
    const eventTokenRows: IndexedEventTokenInsertRow[] = [];
    for (const parsed of parsedEvents) {
      const event = parsed.event;
      const searchText = isSessionIndexSearchableTapeEvent(event)
        ? extractEventSearchText(event)
        : "";
      eventRows.push({
        eventId: event.id,
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        turn: event.turn ?? null,
        type: event.type,
        payloadJson: JSON.stringify(event.payload ?? {}),
        searchText,
        logPath,
        logOffset: parsed.logOffset,
      });
      if (!searchText) continue;
      for (const token of uniqueStrings(tokenizeSearchText(searchText))) {
        eventTokenRows.push({
          token,
          eventId: event.id,
          sessionId: event.sessionId,
          type: event.type,
          timestamp: event.timestamp,
        });
      }
    }

    await this.insertEventRows(eventRows);
    await this.deleteEventTokens(eventRows.map((row) => row.eventId));
    await this.insertEventTokenRows(eventTokenRows);
  }

  private async insertEventRows(rows: readonly IndexedEventInsertRow[]): Promise<void> {
    for (const chunk of chunkArray(rows, 100)) {
      const params: SqlParams = {};
      const values = chunk.map((row, index) => {
        params[`eventId${index}`] = row.eventId;
        params[`sessionId${index}`] = row.sessionId;
        params[`timestamp${index}`] = String(row.timestamp);
        params[`turn${index}`] = row.turn;
        params[`type${index}`] = row.type;
        params[`payloadJson${index}`] = row.payloadJson;
        params[`searchText${index}`] = row.searchText;
        params[`logPath${index}`] = row.logPath;
        params[`logOffset${index}`] = String(row.logOffset);
        return `(
          $eventId${index},
          $sessionId${index},
          cast($timestamp${index} as double),
          $turn${index},
          $type${index},
          $payloadJson${index},
          $searchText${index},
          $logPath${index},
          cast($logOffset${index} as bigint)
        )`;
      });
      await this.connection.run(
        `
        insert or replace into events (
          event_id, session_id, timestamp, turn, type, payload_json, search_text, log_path, log_offset
        ) values ${values.join(", ")}
      `,
        params,
      );
    }
  }

  private async deleteEventTokens(eventIds: readonly string[]): Promise<void> {
    for (const chunk of chunkArray(uniqueStrings(eventIds), 500)) {
      const params: SqlParams = {};
      const eventFilter = buildInList("event", chunk, params);
      await this.connection.run(
        `delete from event_tokens where event_id in (${eventFilter})`,
        params,
      );
    }
  }

  private async insertEventTokenRows(rows: readonly IndexedEventTokenInsertRow[]): Promise<void> {
    for (const chunk of chunkArray(rows, 500)) {
      const params: SqlParams = {};
      const values = chunk.map((row, index) => {
        params[`token${index}`] = row.token;
        params[`eventId${index}`] = row.eventId;
        params[`sessionId${index}`] = row.sessionId;
        params[`type${index}`] = row.type;
        params[`timestamp${index}`] = String(row.timestamp);
        return `(
          $token${index},
          $eventId${index},
          $sessionId${index},
          $type${index},
          cast($timestamp${index} as double)
        )`;
      });
      await this.connection.run(
        `
          insert into event_tokens (token, event_id, session_id, type, timestamp)
          values ${values.join(", ")}
        `,
        params,
      );
    }
  }

  private async rebuildSessionProjection(
    sessionId: string,
    logPath: string,
    stat: Stats,
    byteOffset: number,
  ): Promise<void> {
    const rows = await this.selectRows<EventRow>(
      `
        select event_id, session_id, timestamp, turn, type, payload_json, search_text, log_path, log_offset
        from events
        where session_id = $sessionId
        order by log_offset asc
      `,
      { sessionId },
    );
    if (rows.length === 0) {
      return;
    }

    const records = rows.map(rowToEventRecord);
    const taskGoal = extractTaskGoal(records);
    const fallbackRoots = extractTargetRoots(records);
    const descriptor = this.task.getTargetDescriptor(sessionId);
    const primaryRoot = normalizeRoot(
      descriptor.primaryRoot ?? fallbackRoots[0],
      this.workspaceRoot,
    );
    const descriptorRoots = descriptor.roots?.filter((root) => root.trim().length > 0) ?? [];
    const targetRoots = normalizeRoots(
      descriptorRoots.length > 0 ? descriptorRoots : fallbackRoots,
      primaryRoot,
    );
    const digestSnippets = uniqueStrings(
      records
        .filter((event) => isSessionIndexSearchableTapeEvent(event))
        .map((event) => compactText(extractEventSearchText(event), 240))
        .filter((entry) => entry.length > 0),
    ).slice(0, MAX_DIGEST_SNIPPETS);
    const digestText = compactText([taskGoal, ...digestSnippets].filter(Boolean).join(" "), 2_400);

    await this.connection.run(
      `
        insert or replace into sessions (
          session_id,
          repository_root,
          primary_root,
          target_roots_json,
          task_goal,
          digest_text,
          event_count,
          last_event_at
        ) values (
          $sessionId,
          $repositoryRoot,
          $primaryRoot,
          $targetRootsJson,
          $taskGoal,
          $digestText,
          $eventCount,
          cast($lastEventAt as double)
        )
      `,
      {
        sessionId,
        repositoryRoot: this.workspaceRoot,
        primaryRoot,
        targetRootsJson: JSON.stringify(targetRoots),
        taskGoal: taskGoal ?? null,
        digestText,
        eventCount: records.length,
        lastEventAt: String(records.at(-1)?.timestamp ?? 0),
      },
    );

    await this.connection.run("delete from session_target_roots where session_id = $sessionId", {
      sessionId,
    });
    await this.insertSessionTargetRoots(sessionId, targetRoots);
    await this.rebuildSessionBoxProjection(sessionId, records);

    await this.connection.run("delete from session_tokens where session_id = $sessionId", {
      sessionId,
    });
    await this.insertSessionTokens([
      ...tokensForField(sessionId, "task_goal", taskGoal ?? ""),
      ...tokensForField(sessionId, "digest_text", digestText),
    ]);
    await this.insertSessionEventTokens(sessionId);

    await this.connection.run(
      `
        insert or replace into index_state (
          session_id,
          log_path,
          byte_offset,
          mtime_ms,
          indexed_event_count,
          last_indexed_at,
          status,
          schema_version
        ) values (
          $sessionId,
          $logPath,
          cast($byteOffset as bigint),
          cast($mtimeMs as double),
          $indexedEventCount,
          cast($lastIndexedAt as double),
          'ok',
          $schemaVersion
        )
      `,
      {
        sessionId,
        logPath,
        byteOffset: String(byteOffset),
        mtimeMs: String(stat.mtimeMs),
        indexedEventCount: records.length,
        lastIndexedAt: String(Date.now()),
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      },
    );
  }

  private async rebuildSessionBoxProjection(
    sessionId: string,
    records: readonly BrewvaEventRecord[],
  ): Promise<void> {
    const projection = extractSessionBoxProjection(sessionId, records);
    await this.connection.run("delete from session_box where session_id = $sessionId", {
      sessionId,
    });
    if (!projection) return;
    await this.connection.run(
      `
        insert or replace into session_box (
          session_id,
          box_id,
          image,
          created_at,
          last_exec_at,
          fingerprint,
          snapshot_refs_json
        ) values (
          $sessionId,
          $boxId,
          $image,
          cast($createdAt as double),
          cast($lastExecAt as double),
          $fingerprint,
          $snapshotRefsJson
        )
      `,
      {
        sessionId: projection.sessionId,
        boxId: projection.boxId,
        image: projection.image,
        createdAt: String(projection.createdAt),
        lastExecAt: String(projection.lastExecAt),
        fingerprint: projection.fingerprint ?? null,
        snapshotRefsJson: JSON.stringify(projection.snapshotRefs),
      },
    );
  }

  private async insertSessionTargetRoots(
    sessionId: string,
    targetRoots: readonly string[],
  ): Promise<void> {
    for (const chunk of chunkArray(targetRoots, 200)) {
      const params: SqlParams = {};
      const values = chunk.map((targetRoot, index) => {
        params[`sessionId${index}`] = sessionId;
        params[`targetRoot${index}`] = targetRoot;
        return `($sessionId${index}, $targetRoot${index})`;
      });
      await this.connection.run(
        `
          insert into session_target_roots (session_id, target_root)
          values ${values.join(", ")}
        `,
        params,
      );
    }
  }

  private async insertSessionTokens(
    rows: readonly { token: string; sessionId: string; sourceField: string }[],
  ): Promise<void> {
    for (const chunk of chunkArray(rows, 500)) {
      const params: SqlParams = {};
      const values = chunk.map((row, index) => {
        params[`token${index}`] = row.token;
        params[`sessionId${index}`] = row.sessionId;
        params[`sourceField${index}`] = row.sourceField;
        return `($token${index}, $sessionId${index}, $sourceField${index})`;
      });
      await this.connection.run(
        `
          insert into session_tokens (token, session_id, source_field)
          values ${values.join(", ")}
        `,
        params,
      );
    }
  }

  private async insertSessionEventTokens(sessionId: string): Promise<void> {
    await this.connection.run(
      `
        insert into session_tokens (token, session_id, source_field)
        select distinct token, session_id, 'event_text'
        from event_tokens
        where session_id = $sessionId
      `,
      { sessionId },
    );
  }

  private async publishReadSnapshot(): Promise<void> {
    await this.connection.run("checkpoint");
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

  private buildScopeSql(
    scope: SessionIndexScope,
    targetRoots: readonly string[],
    params: SqlParams,
  ): string {
    if (scope === "workspace_wide") {
      return "true";
    }
    if (scope === "session_local") {
      return "sessions.session_id = $currentSessionId";
    }
    const clauses = targetRoots.map((root, index) => {
      const rootKey = `scopeRoot${index}`;
      const prefixKey = `scopeRootPrefix${index}`;
      const separatorKey = `scopeSeparator${index}`;
      params[rootKey] = root;
      params[prefixKey] = root.endsWith(sep) ? root : `${root}${sep}`;
      params[separatorKey] = sep;
      return `
        session_target_roots.target_root = $${rootKey}
        or starts_with(session_target_roots.target_root, $${prefixKey})
        or starts_with($${rootKey}, session_target_roots.target_root || $${separatorKey})
      `;
    });
    params.repositoryRoot = this.workspaceRoot;
    return `
      sessions.repository_root = $repositoryRoot
      and exists (
        select 1
        from session_target_roots
        where session_target_roots.session_id = sessions.session_id
          and (${clauses.join(" or ")})
      )
    `;
  }

  private async selectOne<T extends JsonRow>(
    sql: string,
    values?: SqlParams,
  ): Promise<T | undefined> {
    return (await this.selectRows<T>(sql, values))[0];
  }

  private async selectRows<T extends JsonRow>(sql: string, values?: SqlParams): Promise<T[]> {
    const result = await this.connection.run(sql, values);
    return (await result.getRowObjectsJS()) as T[];
  }
}

interface WriteLease {
  acquired: boolean;
  release(): void;
}

interface CachedDuckDBInstance {
  instance: DuckDBInstance;
  refs: number;
}

interface DuckDBInstanceHandle {
  instance: DuckDBInstance;
  release(): void;
}

async function acquireDuckDBInstance(
  duckdb: DuckDBModule,
  dbPath: string,
  readOnly: boolean,
): Promise<DuckDBInstanceHandle> {
  const cacheKey = duckDBInstanceCacheKey(dbPath, readOnly);
  const cached = instanceCache.get(cacheKey);
  if (cached) {
    cached.refs += 1;
    return {
      instance: cached.instance,
      release: () => releaseDuckDBInstance(cacheKey),
    };
  }

  const instance = await duckdb.DuckDBInstance.create(
    dbPath,
    readOnly ? { access_mode: "READ_ONLY" } : undefined,
  );
  instanceCache.set(cacheKey, {
    instance,
    refs: 1,
  });
  return {
    instance,
    release: () => releaseDuckDBInstance(cacheKey),
  };
}

function duckDBInstanceCacheKey(dbPath: string, readOnly: boolean): string {
  return `${readOnly ? "ro" : "rw"}:${dbPath}`;
}

function releaseDuckDBInstance(cacheKey: string): void {
  const cached = instanceCache.get(cacheKey);
  if (!cached) return;
  cached.refs -= 1;
  if (cached.refs > 0) return;
  instanceCache.delete(cacheKey);
  try {
    cached.instance.closeSync();
  } catch {}
}

function acquireWriteLease(lockPath: string): WriteLease {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeWriteLeaseFile(fd, process.pid);
      const heartbeat = setInterval(() => {
        try {
          writeFileSync(lockPath, writeLeaseContent(process.pid), "utf8");
        } catch {}
      }, WRITE_LEASE_HEARTBEAT_MS);
      if (typeof heartbeat === "object" && heartbeat !== null && "unref" in heartbeat) {
        (heartbeat as { unref(): void }).unref();
      }
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            closeSync(fd);
          } catch {}
          try {
            unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch {
      if (attempt === 0 && removeStaleWriteLease(lockPath)) {
        continue;
      }
      return {
        acquired: false,
        release: () => {},
      };
    }
  }
  return {
    acquired: false,
    release: () => {},
  };
}

function writeWriteLeaseFile(fd: number, pid: number): void {
  writeFileSync(fd, writeLeaseContent(pid), "utf8");
}

function writeLeaseContent(pid: number): string {
  return `${pid}\n${Date.now()}\n`;
}

function removeStaleWriteLease(lockPath: string): boolean {
  let content = "";
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  if (!isWriteLeaseStale(content)) {
    return false;
  }
  try {
    if (readFileSync(lockPath, "utf8") !== content) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isWriteLeaseStale(content: string, now = Date.now()): boolean {
  const [pidText, timestampText] = content.split(/\r?\n/u);
  const pid = Number(pidText);
  const timestamp = Number(timestampText);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  if (!isProcessRunning(pid)) {
    return true;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return true;
  }
  return now - timestamp > WRITE_LEASE_STALE_MS;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return code === "EPERM";
  }
}

function resolvePublishedReadSnapshotPath(
  manifestPath: string,
  snapshotDir: string,
): string | undefined {
  const manifest = readReadSnapshotManifest(manifestPath);
  if (!manifest || manifest.schemaVersion !== SESSION_INDEX_SCHEMA_VERSION) {
    return undefined;
  }
  const snapshotPath = resolve(snapshotDir, manifest.snapshotFile);
  return existsSync(snapshotPath) ? snapshotPath : undefined;
}

function readReadSnapshotManifest(manifestPath: string): ReadSnapshotManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.schemaVersion !== SESSION_INDEX_SCHEMA_VERSION) return undefined;
    if (typeof parsed.snapshotFile !== "string" || parsed.snapshotFile.length === 0) {
      return undefined;
    }
    if (typeof parsed.publishedAt !== "number" || !Number.isFinite(parsed.publishedAt)) {
      return undefined;
    }
    return {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      snapshotFile: parsed.snapshotFile,
      publishedAt: parsed.publishedAt,
      writerPid:
        typeof parsed.writerPid === "number" && Number.isFinite(parsed.writerPid)
          ? parsed.writerPid
          : 0,
      indexedSessions:
        typeof parsed.indexedSessions === "number" && Number.isFinite(parsed.indexedSessions)
          ? parsed.indexedSessions
          : 0,
      indexedEvents:
        typeof parsed.indexedEvents === "number" && Number.isFinite(parsed.indexedEvents)
          ? parsed.indexedEvents
          : 0,
    };
  } catch {
    return undefined;
  }
}

function writeReadSnapshotManifest(manifestPath: string, manifest: ReadSnapshotManifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tempPath, manifestPath);
}

function pruneReadSnapshots(snapshotDir: string, activeSnapshotFile: string): void {
  let entries: string[];
  try {
    entries = readdirSync(snapshotDir).filter((entry) => entry.endsWith(".duckdb"));
  } catch {
    return;
  }
  const stale = entries
    .filter((entry) => entry !== activeSnapshotFile)
    .map((entry) => {
      const path = join(snapshotDir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {}
      return { entry, path, mtimeMs };
    })
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(Math.max(0, SNAPSHOT_KEEP_COUNT - 1));
  for (const entry of stale) {
    try {
      rmSync(entry.path, { force: true });
    } catch {}
  }
}

function readEventsFromLog(
  logPath: string,
  expectedSessionId: string,
  byteOffset: number,
): ReadLogResult {
  if (!existsSync(logPath)) {
    return { events: [], nextOffset: byteOffset };
  }
  const size = statSync(logPath).size;
  if (byteOffset >= size) {
    return { events: [], nextOffset: byteOffset };
  }
  const fd = openSync(logPath, "r");
  const chunk = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
  const rows: ParsedLogEvent[] = [];
  let position = byteOffset;
  let carry = Buffer.alloc(0);
  let carryOffset = byteOffset;
  let nextOffset = byteOffset;
  try {
    while (position < size) {
      const bytesToRead = Math.min(LOG_READ_CHUNK_BYTES, size - position);
      const bytesRead = readSync(fd, chunk, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        break;
      }
      const current = chunk.subarray(0, bytesRead);
      const buffer = carry.length > 0 ? Buffer.concat([carry, current]) : current;
      const bufferOffset = carry.length > 0 ? carryOffset : position;
      let cursor = 0;

      while (cursor < buffer.length) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline < 0) {
          break;
        }
        const lineEnd = newline;
        if (lineEnd > cursor) {
          const line = buffer.subarray(cursor, lineEnd).toString("utf8").trim();
          if (line.length > 0) {
            const parsed = parseEventRecord(line);
            if (parsed && parsed.sessionId === expectedSessionId) {
              rows.push({
                event: parsed,
                logOffset: bufferOffset + cursor,
              });
            }
          }
        }
        cursor = newline + 1;
        nextOffset = bufferOffset + cursor;
      }

      carry = cursor < buffer.length ? Buffer.from(buffer.subarray(cursor)) : Buffer.alloc(0);
      carryOffset = bufferOffset + cursor;
      position += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  if (carry.length > 0) {
    const line = carry.toString("utf8").trim();
    if (line.length > 0) {
      const parsed = parseEventRecord(line);
      if (parsed && parsed.sessionId === expectedSessionId) {
        rows.push({
          event: parsed,
          logOffset: carryOffset,
        });
      }
      if (parsed) {
        nextOffset = carryOffset + carry.length;
      }
    }
  }
  return { events: rows, nextOffset };
}

function parseEventRecord(line: string): BrewvaEventRecord | undefined {
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
      return {
        id: value.id,
        sessionId: value.sessionId,
        type: value.type,
        timestamp: value.timestamp,
        ...(value.turn === undefined ? {} : { turn: value.turn }),
        payload: normalizePayload(value.payload),
      } as BrewvaEventRecord;
    }
  } catch {}
  return undefined;
}

function rowToEventRecord(row: EventRow): BrewvaEventRecord {
  return {
    id: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    timestamp: row.timestamp,
    ...(row.turn === null ? {} : { turn: row.turn }),
    payload: parsePayload(row.payload_json),
  } as BrewvaEventRecord;
}

function mapSessionRow(row: SessionRow, tokenScore: number): SessionIndexDigest {
  const digest: SessionIndexDigest = {
    sessionId: row.session_id,
    eventCount: row.event_count,
    lastEventAt: row.last_event_at,
    repositoryRoot: row.repository_root,
    primaryRoot: row.primary_root,
    targetRoots: parseStringArray(row.target_roots_json),
    digestText: row.digest_text,
    tokenScore,
  };
  if (row.task_goal) {
    digest.taskGoal = row.task_goal;
  }
  return digest;
}

function mapEventRow(row: EventRow, tokenScore: number): SessionIndexTapeEvidence {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    ...(row.turn === null ? {} : { turn: row.turn }),
    type: row.type,
    payload: parsePayload(row.payload_json),
    searchText: row.search_text,
    logPath: row.log_path,
    logOffset: Number(row.log_offset),
    tokenScore,
  };
}

function mapSessionBoxRow(row: SessionBoxRow): SessionIndexBox {
  return {
    sessionId: row.session_id,
    boxId: row.box_id,
    image: row.image,
    createdAt: row.created_at,
    lastExecAt: row.last_exec_at,
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    snapshotRefs: parseStringArray(row.snapshot_refs_json),
  };
}

function extractSessionBoxProjection(
  sessionId: string,
  records: readonly BrewvaEventRecord[],
): SessionIndexBox | undefined {
  let projection: SessionIndexBox | undefined;
  for (const event of records) {
    const payload = normalizePayload(event.payload);
    if (event.type === "box.acquired") {
      const boxId = readString(payload.boxId);
      if (!boxId) continue;
      projection = {
        sessionId,
        boxId,
        image: readString(payload.image) ?? "unknown",
        createdAt: event.timestamp,
        lastExecAt: event.timestamp,
        ...(readString(payload.fingerprint)
          ? { fingerprint: readString(payload.fingerprint) }
          : {}),
        snapshotRefs: [],
      };
      continue;
    }
    if (!projection) continue;
    if (event.type === "box.exec.started" || event.type === "box.exec.completed") {
      const boxId = readString(payload.boxId);
      if (!boxId || boxId === projection.boxId) {
        projection.lastExecAt = event.timestamp;
      }
      continue;
    }
    if (event.type === "box.snapshot.created") {
      const boxId = readString(payload.boxId);
      if (boxId && boxId !== projection.boxId) continue;
      const snapshotRef = readString(payload.snapshotId) ?? readString(payload.snapshotRef);
      if (snapshotRef) {
        projection.snapshotRefs = uniqueStrings([...projection.snapshotRefs, snapshotRef]);
      }
    }
  }
  return projection;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizePayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function collectStringLeaves(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      sink.push(normalized);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, sink);
    }
    return;
  }
  for (const entry of Object.values(value)) {
    collectStringLeaves(entry, sink);
  }
}

function extractEventSearchText(event: BrewvaEventRecord): string {
  const parts: string[] = [event.type];
  if (isRecord(event.payload)) {
    const leaves: string[] = [];
    collectStringLeaves(event.payload, leaves);
    parts.push(...leaves.slice(0, 8));
  }
  return compactText(parts.join(" "), 600);
}

function extractTaskGoal(events: readonly BrewvaEventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "task_event" || !isRecord(event.payload)) {
      continue;
    }
    const spec = isRecord(event.payload.spec) ? event.payload.spec : undefined;
    const goal = readString(spec?.goal);
    if (goal) {
      return goal;
    }
  }
  return undefined;
}

function extractTargetRoots(events: readonly BrewvaEventRecord[]): string[] {
  const roots = new Set<string>();
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const spec = isRecord(event.payload.spec) ? event.payload.spec : undefined;
    const targets = isRecord(spec?.targets) ? spec.targets : undefined;
    const files = Array.isArray(targets?.files) ? targets.files : [];
    for (const file of files) {
      const normalized = readString(file);
      if (normalized) {
        roots.add(normalized);
      }
    }
  }
  return [...roots].toSorted();
}

function normalizeRoot(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback);
}

function normalizeRoots(roots: readonly string[] | undefined, fallback: string): string[] {
  const normalized = uniqueStrings(
    (roots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => resolve(root)),
  );
  return normalized.length > 0 ? normalized : [resolve(fallback)];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function tokensForField(
  sessionId: string,
  sourceField: string,
  value: string,
): { token: string; sessionId: string; sourceField: string }[] {
  return uniqueStrings(tokenizeSearchText(value)).map((token) => ({
    token,
    sessionId,
    sourceField,
  }));
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function buildInList(prefix: string, values: readonly string[], params: SqlParams): string {
  return values
    .map((value, index) => {
      const key = `${prefix}${index}`;
      params[key] = value;
      return `$${key}`;
    })
    .join(", ");
}

const SESSION_INDEX_SEARCHABLE_TAPE_EVENT_TYPES = new Set([
  "task_event",
  "truth_event",
  "tool_result_recorded",
  "skill_completed",
  "session_compact",
  "turn_input_recorded",
  "turn_render_committed",
  "reasoning_checkpoint",
  "reasoning_revert",
  "schedule_event",
  "effect_commitment_approval_requested",
  "effect_commitment_approval_decided",
  "effect_commitment_approval_consumed",
  "reversible_mutation_prepared",
  "reversible_mutation_recorded",
  "reversible_mutation_rolled_back",
  "recovery_wal_appended",
  "rollback",
  "patch_recorded",
  "decision_receipt_recorded",
  "verification_outcome_recorded",
]);

function isSessionIndexSearchableTapeEvent(event: Pick<BrewvaEventRecord, "type">): boolean {
  return SESSION_INDEX_SEARCHABLE_TAPE_EVENT_TYPES.has(event.type);
}
