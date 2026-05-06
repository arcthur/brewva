import { SESSION_INDEX_SCHEMA_SQL } from "../schema/sql.js";
import type { DuckDBConnection } from "./instance.js";
import { selectOne, selectRows } from "./query.js";

interface IndexStateRow {
  byte_offset?: bigint | number;
}

interface SessionIdRow {
  session_id: string;
}

interface StatusRow {
  indexed_sessions: bigint | number;
  indexed_events: bigint | number;
  last_indexed_at?: number | null;
}

export interface IndexedSessionState {
  byteOffset: number;
}

export interface SessionIndexStatusCounts {
  indexedSessions: number;
  indexedEvents: number;
  lastIndexedAt?: number;
}

const INDEXED_SESSION_STATE_SQL =
  "select byte_offset from index_state where session_id = $sessionId";

const INDEXED_SESSION_IDS_SQL = "select session_id from index_state";

const STATUS_COUNTS_SQL = `
  select
    (select count(*) from sessions) as indexed_sessions,
    (select count(*) from events) as indexed_events,
    (select max(last_indexed_at) from index_state) as last_indexed_at
`;

const DELETE_SESSION_TABLES = [
  "event_tokens",
  "session_tokens",
  "session_target_roots",
  "session_box",
  "session_rewind_targets",
  "session_lineage_nodes",
  "session_lineage_summaries",
  "session_lineage_outcomes",
  "session_lineage_adopted_outcomes",
  "session_context_entries",
  "session_active_lineage_nodes",
  "events",
  "sessions",
  "index_state",
] as const;

export async function ensureSessionIndexSchema(connection: DuckDBConnection): Promise<void> {
  await connection.run(SESSION_INDEX_SCHEMA_SQL);
}

export async function readSessionIndexStatusCounts(
  connection: DuckDBConnection,
): Promise<SessionIndexStatusCounts> {
  const counts = await selectOne<StatusRow>(connection, STATUS_COUNTS_SQL);
  const lastIndexedAt =
    typeof counts?.last_indexed_at === "number" && Number.isFinite(counts.last_indexed_at)
      ? counts.last_indexed_at
      : undefined;
  return {
    indexedSessions: Number(counts?.indexed_sessions ?? 0),
    indexedEvents: Number(counts?.indexed_events ?? 0),
    ...(lastIndexedAt === undefined ? {} : { lastIndexedAt }),
  };
}

export async function readIndexedSessionState(
  connection: DuckDBConnection,
  sessionId: string,
): Promise<IndexedSessionState | undefined> {
  const row = await selectOne<IndexStateRow>(connection, INDEXED_SESSION_STATE_SQL, {
    sessionId,
  });
  return row ? { byteOffset: Number(row.byte_offset ?? 0) } : undefined;
}

export async function listIndexedSessionIds(connection: DuckDBConnection): Promise<string[]> {
  const rows = await selectRows<SessionIdRow>(connection, INDEXED_SESSION_IDS_SQL);
  return rows.map((row) => row.session_id);
}

export async function deleteSessionRows(
  connection: DuckDBConnection,
  sessionId: string,
): Promise<void> {
  for (const table of DELETE_SESSION_TABLES) {
    await connection.run(`delete from ${table} where session_id = $sessionId`, { sessionId });
  }
}

export async function clearSessionIndexRows(connection: DuckDBConnection): Promise<void> {
  await runSessionIndexTransaction(connection, async () => {
    for (const table of DELETE_SESSION_TABLES) {
      await connection.run(`delete from ${table}`);
    }
  });
}

export async function runSessionIndexTransaction<T>(
  connection: DuckDBConnection,
  work: () => Promise<T>,
): Promise<T> {
  await connection.run("begin transaction");
  try {
    const result = await work();
    await connection.run("commit");
    return result;
  } catch (error) {
    await connection.run("rollback");
    throw error;
  }
}

export async function checkpointSessionIndex(connection: DuckDBConnection): Promise<void> {
  await connection.run("checkpoint");
}
