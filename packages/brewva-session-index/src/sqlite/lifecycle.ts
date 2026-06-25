import { SESSION_INDEX_SCHEMA_VERSION } from "../api.js";
import { SESSION_INDEX_SCHEMA_SQL } from "../schema/sql.js";
import type { SqliteConnection } from "./instance.js";
import { run, selectOne, selectRows } from "./query.js";

interface IndexStateRow {
  indexed_event_count?: number;
}

interface SessionIdRow {
  session_id: string;
}

interface StatusRow {
  indexed_sessions: number;
  indexed_events: number;
  last_indexed_at?: number | null;
}

interface SchemaMismatchRow {
  mismatched_rows: number;
}

export interface IndexedSessionState {
  indexedEventCount: number;
}

export interface SessionIndexStatusCounts {
  indexedSessions: number;
  indexedEvents: number;
  lastIndexedAt?: number;
}

const INDEXED_SESSION_STATE_SQL =
  "select indexed_event_count from index_state where session_id = $sessionId";

const INDEXED_SESSION_IDS_SQL = "select session_id from index_state";

const STATUS_COUNTS_SQL = `
  select
    (select count(*) from sessions) as indexed_sessions,
    (select count(*) from events) as indexed_events,
    (select max(last_indexed_at) from index_state) as last_indexed_at
`;

// Per-session row owners. The former event_tokens / session_tokens plain tables
// are now the event_fts / session_fts FTS5 virtual tables; both carry a
// session_id column so a per-session delete still works.
const DELETE_SESSION_TABLES = [
  "event_fts",
  "session_fts",
  "session_target_roots",
  "session_box",
  "session_rewind_targets",
  "session_lineage_nodes",
  "session_lineage_summaries",
  "session_lineage_outcomes",
  "session_lineage_adopted_outcomes",
  "session_context_entries",
  "session_active_lineage_nodes",
  "session_delegation_runs",
  "session_worker_results",
  "session_projection_cursors",
  "session_harness_trace_snapshots",
  "events",
  "sessions",
  "index_state",
] as const;

export async function ensureSessionIndexSchema(connection: SqliteConnection): Promise<void> {
  connection.exec(SESSION_INDEX_SCHEMA_SQL);
}

export async function readSessionIndexStatusCounts(
  connection: SqliteConnection,
): Promise<SessionIndexStatusCounts> {
  const counts = await selectOne<StatusRow>(connection, STATUS_COUNTS_SQL);
  const lastIndexedAt =
    typeof counts?.last_indexed_at === "number" && Number.isFinite(counts.last_indexed_at)
      ? counts.last_indexed_at
      : undefined;
  return {
    indexedSessions: counts?.indexed_sessions ?? 0,
    indexedEvents: counts?.indexed_events ?? 0,
    ...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
  };
}

export async function readIndexedSessionState(
  connection: SqliteConnection,
  sessionId: string,
): Promise<IndexedSessionState | undefined> {
  const row = await selectOne<IndexStateRow>(connection, INDEXED_SESSION_STATE_SQL, { sessionId });
  return row ? { indexedEventCount: row.indexed_event_count ?? 0 } : undefined;
}

export async function listIndexedSessionIds(connection: SqliteConnection): Promise<string[]> {
  const rows = await selectRows<SessionIdRow>(connection, INDEXED_SESSION_IDS_SQL);
  return rows.map((row) => row.session_id);
}

export async function deleteSessionRows(
  connection: SqliteConnection,
  sessionId: string,
): Promise<void> {
  for (const table of DELETE_SESSION_TABLES) {
    await run(connection, `delete from ${table} where session_id = $sessionId`, { sessionId });
  }
}

/**
 * True when any indexed session was written under a different schema version —
 * the signal that a full rebuild is required (taken inside one transaction, RFC
 * posture A) rather than an incremental catch-up. Detection is decoupled from
 * clearing so the clear + reproject can share a single publish-barrier transaction.
 */
export async function hasSchemaMismatch(connection: SqliteConnection): Promise<boolean> {
  const row = await selectOne<SchemaMismatchRow>(
    connection,
    "select count(*) as mismatched_rows from index_state where schema_version <> $schemaVersion",
    { schemaVersion: SESSION_INDEX_SCHEMA_VERSION },
  );
  return (row?.mismatched_rows ?? 0) > 0;
}

export async function runSessionIndexTransaction<T>(
  connection: SqliteConnection,
  work: () => Promise<T>,
): Promise<T> {
  await run(connection, "begin");
  try {
    const result = await work();
    await run(connection, "commit");
    return result;
  } catch (error) {
    await run(connection, "rollback");
    throw error;
  }
}

export async function checkpointSessionIndex(connection: SqliteConnection): Promise<void> {
  await run(connection, "PRAGMA wal_checkpoint(TRUNCATE)");
}
