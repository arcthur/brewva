import { tokenizeSearchQuery } from "@brewva/brewva-search";
import { uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type {
  FilterSessionIdsByScopeInput,
  ListSessionDigestsInput,
  QuerySessionDigestsInput,
  SessionIndexDigest,
} from "../api.js";
import { mapSessionRow, type SessionRow } from "../projection/rows.js";
import { normalizeRoots } from "../roots.js";
import { buildInList, type SqlParams } from "../sql/params.js";
import { encodeTokensToMatchExpression } from "../sqlite/surrogate.js";
import { logisticBm25Score, type Bm25ScoredRow } from "./fts.js";
import type { SessionIndexQueryPort } from "./port.js";
import { buildSessionScopeSql } from "./scope.js";

interface SessionIdRow {
  session_id: string;
}

export async function querySessionDigestRows(input: {
  query: QuerySessionDigestsInput;
  workspaceRoot: string;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexDigest[]> {
  const queryTokens = uniqueNonEmptyStrings(tokenizeSearchQuery(input.query.query));
  if (queryTokens.length === 0) {
    return [];
  }

  await input.port.ensureAvailable();

  const targetRoots = normalizeRoots(input.query.targetRoots, input.workspaceRoot);
  const params: SqlParams = {
    currentSessionId: input.query.currentSessionId,
    ftsExpr: encodeTokensToMatchExpression(queryTokens),
    limit: Math.max(1, Math.trunc(input.query.limit)),
  };
  const scopeFilter = buildSessionScopeSql({
    scope: input.query.scope,
    targetRoots,
    workspaceRoot: input.workspaceRoot,
    params,
  });
  // FTS5 bm25() is only defined inside a MATCH query, so coverage scoring moves
  // into a subquery joined back to `sessions`. A LEFT JOIN keeps the
  // currentSessionId fallback row (which has no match, hence a NULL bm25_score).
  const matchJoin = `
    left join (
      select session_id, bm25(session_fts) as bm25_score
      from session_fts
      where session_fts match $ftsExpr
    ) fts on fts.session_id = sessions.session_id
  `;
  const rows = await input.port.selectRows<SessionRow & Bm25ScoredRow>(
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
        fts.bm25_score as bm25_score
      from sessions
      ${matchJoin}
      where ${scopeFilter}
        and (fts.bm25_score is not null or sessions.session_id = $currentSessionId)
      order by
        case when fts.bm25_score is null then 1 else 0 end asc,
        fts.bm25_score asc,
        case when sessions.session_id = $currentSessionId then 1 else 0 end desc,
        sessions.last_event_at desc
      limit $limit
    `,
    params,
  );

  return rows.map((row) => mapSessionRow(row, logisticBm25Score(row.bm25_score)));
}

export async function listSessionDigestRows(input: {
  query: ListSessionDigestsInput;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexDigest[]> {
  await input.port.ensureAvailable();

  const limit = input.query.limit ? Math.max(1, Math.trunc(input.query.limit)) : 1_000_000;
  const rows = await input.port.selectRows<SessionRow>(
    `
      select
        session_id,
        event_count,
        last_event_at,
        repository_root,
        primary_root,
        target_roots_json,
        task_goal,
        digest_text
      from sessions
      order by last_event_at desc
      limit $limit
    `,
    { limit },
  );
  return rows.map((row) => mapSessionRow(row, 0));
}

export async function getSessionDigestRow(input: {
  sessionId: string;
  port: SessionIndexQueryPort;
}): Promise<SessionIndexDigest | undefined> {
  await input.port.ensureAvailable();

  const row = await input.port.selectOne<SessionRow>(
    `
      select
        session_id,
        event_count,
        last_event_at,
        repository_root,
        primary_root,
        target_roots_json,
        task_goal,
        digest_text
      from sessions
      where session_id = $sessionId
      limit 1
    `,
    { sessionId: input.sessionId },
  );
  return row ? mapSessionRow(row, 0) : undefined;
}

export async function filterScopedSessionIds(input: {
  query: FilterSessionIdsByScopeInput;
  workspaceRoot: string;
  port: SessionIndexQueryPort;
}): Promise<string[]> {
  const sessionIds = uniqueNonEmptyStrings(input.query.sessionIds);
  if (sessionIds.length === 0) return [];

  await input.port.ensureAvailable();

  const targetRoots = normalizeRoots(input.query.targetRoots, input.workspaceRoot);
  const params: SqlParams = {};
  if (input.query.scope === "session_local") {
    params.currentSessionId = input.query.currentSessionId;
  }
  const sessionFilter = buildInList("session", sessionIds, params);
  const scopeFilter = buildSessionScopeSql({
    scope: input.query.scope,
    targetRoots,
    workspaceRoot: input.workspaceRoot,
    params,
  });
  const rows = await input.port.selectRows<SessionIdRow>(
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
