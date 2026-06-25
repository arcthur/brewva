import { chunkArray, uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { TASK_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { SESSION_INDEX_SCHEMA_VERSION, type SessionIndexTaskSource } from "../api.js";
import { buildEventSearchTokenRows, buildSessionFieldTokenRows } from "../evidence/tokens.js";
import { isRecord, readString } from "../json.js";
import { normalizeRoot, normalizeRoots } from "../roots.js";
import type { SqlParams } from "../sql/params.js";
import type { SqliteConnection } from "../sqlite/instance.js";
import { run, selectRows } from "../sqlite/query.js";
import { encodeTokensToColumn } from "../sqlite/surrogate.js";
import { compactText } from "../text.js";
import { rebuildSessionBoxProjection } from "./box.js";
import { rebuildSessionDelegationProjection } from "./delegation.js";
import { rebuildSessionHarnessProjection } from "./harness.js";
import { rebuildSessionLineageProjection } from "./lineage.js";
import { rebuildSessionRewindTargetProjection } from "./rewind.js";
import { rowToEventRecord, type EventRow } from "./rows.js";

const MAX_DIGEST_SNIPPETS = 20;

export async function rebuildSessionProjection(input: {
  connection: SqliteConnection;
  workspaceRoot: string;
  task: SessionIndexTaskSource;
  sessionId: string;
  sourceUri: string;
  sourceCursor: number;
}): Promise<void> {
  const rows = await selectRows<EventRow>(
    input.connection,
    `
      select event_id, session_id, timestamp, turn, type, payload_json, search_text, source_uri, source_sequence
      from events
      where session_id = $sessionId
      order by source_sequence asc
    `,
    { sessionId: input.sessionId },
  );
  if (rows.length === 0) {
    return;
  }

  const records = rows.map(rowToEventRecord);
  const taskGoal = extractTaskGoal(records);
  const fallbackRoots = extractTargetRoots(records);
  const descriptor = input.task.target.getDescriptor(input.sessionId);
  const primaryRoot = normalizeRoot(
    descriptor.primaryRoot ?? fallbackRoots[0],
    input.workspaceRoot,
  );
  const descriptorRoots = descriptor.roots?.filter((root) => root.trim().length > 0) ?? [];
  const targetRoots = normalizeRoots(
    descriptorRoots.length > 0 ? descriptorRoots : fallbackRoots,
    primaryRoot,
  );
  const digestSnippets = uniqueNonEmptyStrings(
    rows.map((row) => compactText(row.search_text, 240)).filter((entry) => entry.length > 0),
  ).slice(0, MAX_DIGEST_SNIPPETS);
  const digestText = compactText([taskGoal, ...digestSnippets].filter(Boolean).join(" "), 2_400);

  await run(
    input.connection,
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
        cast($lastEventAt as real)
      )
    `,
    {
      sessionId: input.sessionId,
      repositoryRoot: input.workspaceRoot,
      primaryRoot,
      targetRootsJson: JSON.stringify(targetRoots),
      taskGoal: taskGoal ?? null,
      digestText,
      eventCount: records.length,
      lastEventAt: String(records.at(-1)?.timestamp ?? 0),
    },
  );

  await run(input.connection, "delete from session_target_roots where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await insertSessionTargetRoots(input.connection, input.sessionId, targetRoots);
  await rebuildSessionBoxProjection({
    connection: input.connection,
    sessionId: input.sessionId,
    records,
  });
  await rebuildSessionRewindTargetProjection({
    connection: input.connection,
    sessionId: input.sessionId,
    records,
  });
  await rebuildSessionLineageProjection({
    connection: input.connection,
    sessionId: input.sessionId,
    records,
  });
  await rebuildSessionDelegationProjection({
    connection: input.connection,
    sessionId: input.sessionId,
    records,
  });
  await rebuildSessionHarnessProjection({
    connection: input.connection,
    sessionId: input.sessionId,
    records,
  });

  // One FTS5 row per session: task_goal + digest_text + per-event search-text
  // tokens (the union that formerly populated session_tokens, including the
  // event_text rows that used to come from `event_tokens`). Tokens are deduped
  // to mirror the old `distinct` aggregation, then surrogate-encoded into a single
  // `body` so FTS5's ascii tokenizer is a pure passthrough.
  await run(input.connection, "delete from session_fts where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  const sessionBodyTokens = uniqueNonEmptyStrings([
    ...buildSessionFieldTokenRows({
      sessionId: input.sessionId,
      sourceField: "task_goal",
      value: taskGoal ?? "",
    }).map((row) => row.token),
    ...buildSessionFieldTokenRows({
      sessionId: input.sessionId,
      sourceField: "digest_text",
      value: digestText,
    }).map((row) => row.token),
    ...rows.flatMap((row) =>
      buildEventSearchTokenRows({
        eventId: row.event_id,
        sessionId: row.session_id,
        type: row.type,
        timestamp: row.timestamp,
        searchText: row.search_text,
      }).map((tokenRow) => tokenRow.token),
    ),
  ]);
  if (sessionBodyTokens.length > 0) {
    await run(
      input.connection,
      "insert into session_fts (session_id, body) values ($sessionId, $body)",
      { sessionId: input.sessionId, body: encodeTokensToColumn(sessionBodyTokens) },
    );
  }

  await run(
    input.connection,
    `
      insert or replace into index_state (
        session_id,
        source_uri,
        source_cursor,
        mtime_ms,
        indexed_event_count,
        last_indexed_at,
        status,
        schema_version
      ) values (
        $sessionId,
        $sourceUri,
        cast($sourceCursor as integer),
        cast($mtimeMs as real),
        $indexedEventCount,
        cast($lastIndexedAt as real),
        'ok',
        $schemaVersion
      )
    `,
    {
      sessionId: input.sessionId,
      sourceUri: input.sourceUri,
      sourceCursor: String(input.sourceCursor),
      mtimeMs: String(records.at(-1)?.timestamp ?? 0),
      indexedEventCount: records.length,
      lastIndexedAt: String(Date.now()),
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  );
}

async function insertSessionTargetRoots(
  connection: SqliteConnection,
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
    await run(
      connection,
      `
        insert into session_target_roots (session_id, target_root)
        values ${values.join(", ")}
      `,
      params,
    );
  }
}

function extractTaskGoal(events: readonly BrewvaEventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== TASK_EVENT_TYPE || !isRecord(event.payload)) {
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
