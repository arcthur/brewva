import type { Stats } from "node:fs";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { chunkArray, uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import { SESSION_INDEX_SCHEMA_VERSION, type SessionIndexTaskSource } from "../api.js";
import type { DuckDBConnection } from "../duckdb/instance.js";
import { selectRows } from "../duckdb/query.js";
import { buildSessionFieldTokenRows, type SessionTokenInsertRow } from "../evidence/tokens.js";
import { isRecord, readString } from "../json.js";
import { normalizeRoot, normalizeRoots } from "../roots.js";
import type { SqlParams } from "../sql/params.js";
import { compactText } from "../text.js";
import { rebuildSessionBoxProjection } from "./box.js";
import { rebuildSessionLineageProjection } from "./lineage.js";
import { rebuildSessionRewindTargetProjection } from "./rewind.js";
import { rowToEventRecord, type EventRow } from "./rows.js";

const MAX_DIGEST_SNIPPETS = 20;

export async function rebuildSessionProjection(input: {
  connection: DuckDBConnection;
  workspaceRoot: string;
  task: SessionIndexTaskSource;
  sessionId: string;
  logPath: string;
  stat: Stats;
  byteOffset: number;
}): Promise<void> {
  const rows = await selectRows<EventRow>(
    input.connection,
    `
      select event_id, session_id, timestamp, turn, type, payload_json, search_text, log_path, log_offset
      from events
      where session_id = $sessionId
      order by log_offset asc
    `,
    { sessionId: input.sessionId },
  );
  if (rows.length === 0) {
    return;
  }

  const records = rows.map(rowToEventRecord);
  const taskGoal = extractTaskGoal(records);
  const fallbackRoots = extractTargetRoots(records);
  const descriptor = input.task.getTargetDescriptor(input.sessionId);
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

  await input.connection.run(
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

  await input.connection.run("delete from session_target_roots where session_id = $sessionId", {
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

  await input.connection.run("delete from session_tokens where session_id = $sessionId", {
    sessionId: input.sessionId,
  });
  await insertSessionTokens(input.connection, [
    ...buildSessionFieldTokenRows({
      sessionId: input.sessionId,
      sourceField: "task_goal",
      value: taskGoal ?? "",
    }),
    ...buildSessionFieldTokenRows({
      sessionId: input.sessionId,
      sourceField: "digest_text",
      value: digestText,
    }),
  ]);
  await insertSessionEventTokens(input.connection, input.sessionId);

  await input.connection.run(
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
      sessionId: input.sessionId,
      logPath: input.logPath,
      byteOffset: String(input.byteOffset),
      mtimeMs: String(input.stat.mtimeMs),
      indexedEventCount: records.length,
      lastIndexedAt: String(Date.now()),
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
    },
  );
}

async function insertSessionTargetRoots(
  connection: DuckDBConnection,
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
    await connection.run(
      `
        insert into session_target_roots (session_id, target_root)
        values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionTokens(
  connection: DuckDBConnection,
  rows: readonly SessionTokenInsertRow[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 500)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`token${index}`] = row.token;
      params[`sessionId${index}`] = row.sessionId;
      params[`sourceField${index}`] = row.sourceField;
      return `($token${index}, $sessionId${index}, $sourceField${index})`;
    });
    await connection.run(
      `
        insert into session_tokens (token, session_id, source_field)
        values ${values.join(", ")}
      `,
      params,
    );
  }
}

async function insertSessionEventTokens(
  connection: DuckDBConnection,
  sessionId: string,
): Promise<void> {
  await connection.run(
    `
      insert into session_tokens (token, session_id, source_field)
      select distinct token, session_id, 'event_text'
      from event_tokens
      where session_id = $sessionId
    `,
    { sessionId },
  );
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
