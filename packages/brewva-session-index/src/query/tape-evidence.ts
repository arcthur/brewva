import { tokenizeSearchQuery } from "@brewva/brewva-search";
import { uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type {
  QueryRecentSessionsInput,
  QueryTapeEvidenceInput,
  SessionIndexRecentSession,
  SessionIndexTapeEvidence,
} from "../api.js";
import { mapEventRow, type EventRow } from "../projection/rows.js";
import { buildInList, type SqlParams } from "../sql/params.js";
import { encodeTokensToMatchExpression } from "../sqlite/surrogate.js";
import { logisticBm25Score, type Bm25ScoredRow } from "./fts.js";
import type { SessionIndexQueryPort } from "./port.js";

interface RecentSessionRow {
  session_id: string;
  event_count: number;
  last_event_at: number;
}

export async function queryTapeEvidenceRows(input: {
  query: QueryTapeEvidenceInput;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexTapeEvidence[]> {
  const sessionIds = uniqueNonEmptyStrings(input.query.sessionIds);
  const queryTokens = uniqueNonEmptyStrings(tokenizeSearchQuery(input.query.query));
  if (sessionIds.length === 0 || queryTokens.length === 0) return [];

  await input.port.ensureAvailable();

  const params: SqlParams = {
    ftsExpr: encodeTokensToMatchExpression(queryTokens),
    limit: Math.max(1, Math.trunc(input.query.limit)),
  };
  const sessionFilter = buildInList("session", sessionIds, params);
  // bm25(event_fts) ranks the matching events; the MATCH constraint scopes to
  // events whose surrogate-encoded body contains any query token, then the
  // session_id allowlist narrows to the requested sessions.
  const rows = await input.port.selectRows<EventRow & Bm25ScoredRow>(
    `
      select
        events.event_id,
        events.session_id,
        events.timestamp,
        events.turn,
        events.type,
        events.payload_json,
        events.search_text,
        events.source_uri,
        events.source_sequence,
        bm25(event_fts) as bm25_score
      from event_fts
      inner join events on events.event_id = event_fts.event_id
      where event_fts match $ftsExpr
        and event_fts.session_id in (${sessionFilter})
      order by bm25(event_fts) asc, events.timestamp desc
      limit $limit
    `,
    params,
  );
  return rows.map((row) => mapEventRow(row, logisticBm25Score(row.bm25_score)));
}

export async function getTapeEventRow(input: {
  sessionId: string;
  eventId: string;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexTapeEvidence | undefined> {
  await input.port.ensureAvailable();

  const row = await input.port.selectOne<EventRow>(
    `
      select event_id, session_id, timestamp, turn, type, payload_json, search_text, source_uri, source_sequence
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

export async function listTapeEventsByTypeRows(input: {
  type: string;
  sessionIds?: readonly string[];
  port: SessionIndexQueryPort;
}): Promise<SessionIndexTapeEvidence[]> {
  // Omitting sessionIds scans the type across all sessions; an explicit (possibly empty after
  // normalization) list narrows — and an explicit empty list means nothing, not everything.
  const sessionIds = input.sessionIds ? uniqueNonEmptyStrings(input.sessionIds) : undefined;
  if (sessionIds && sessionIds.length === 0) return [];

  await input.port.ensureAvailable();

  const params: SqlParams = { type: input.type };
  const sessionFilter = sessionIds ? buildInList("session", sessionIds, params) : undefined;
  // No FTS: list every event of this type (optionally narrowed to the requested sessions) in
  // chronological order so a chronological fold (latest-wins per key, cross-session
  // corroboration grading) is deterministic.
  const rows = await input.port.selectRows<EventRow>(
    `
      select event_id, session_id, timestamp, turn, type, payload_json, search_text, source_uri, source_sequence
      from events
      where type = $type${sessionFilter ? ` and session_id in (${sessionFilter})` : ""}
      order by timestamp asc, source_sequence asc
    `,
    params,
  );
  return rows.map((row) => mapEventRow(row, 0));
}

export async function listRecentSessionRows(input: {
  query: QueryRecentSessionsInput;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexRecentSession[]> {
  await input.port.ensureAvailable();

  const rows = await input.port.selectRows<RecentSessionRow>(
    `
      select session_id, event_count, last_event_at
      from sessions
      order by last_event_at desc
      limit $limit
    `,
    { limit: Math.max(1, Math.trunc(input.query.limit)) },
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    eventCount: row.event_count,
    lastEventAt: row.last_event_at,
  }));
}
