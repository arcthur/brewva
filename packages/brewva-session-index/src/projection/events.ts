import { chunkArray, uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildSessionIndexEventSearchText,
  isSessionIndexTextIndexedEvent,
} from "../evidence/index.js";
import { buildEventSearchTokenRows } from "../evidence/tokens.js";
import { buildInList, type SqlParams } from "../sql/params.js";
import type { SqliteConnection } from "../sqlite/instance.js";
import { run } from "../sqlite/query.js";
import { encodeTokensToColumn } from "../sqlite/surrogate.js";
import type { IndexedEventInsertRow } from "./rows.js";

export interface ParsedSessionIndexEvent {
  event: BrewvaEventRecord;
  sequence: number;
}

interface EventFtsInsertRow {
  eventId: string;
  sessionId: string;
  body: string;
}

export async function upsertSessionEvents(input: {
  connection: SqliteConnection;
  sourceUri: string;
  parsedEvents: readonly ParsedSessionIndexEvent[];
}): Promise<void> {
  if (input.parsedEvents.length === 0) return;

  const eventRows: IndexedEventInsertRow[] = [];
  const eventFtsRows: EventFtsInsertRow[] = [];
  for (const parsed of input.parsedEvents) {
    const event = parsed.event;
    const searchText = isSessionIndexTextIndexedEvent(event)
      ? buildSessionIndexEventSearchText(event)
      : "";
    eventRows.push({
      eventId: event.id,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      turn: event.turn ?? null,
      type: event.type,
      payloadJson: JSON.stringify(event.payload ?? {}),
      searchText,
      sourceUri: input.sourceUri,
      sourceSequence: parsed.sequence,
    });
    // One FTS5 row per event: the per-event tokens (same extraction that fed the
    // former event_tokens table) are surrogate-encoded and joined into a single
    // `body` column so FTS5's ascii tokenizer is a pure passthrough.
    const tokens = buildEventSearchTokenRows({
      eventId: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      searchText,
    }).map((row) => row.token);
    if (tokens.length > 0) {
      eventFtsRows.push({
        eventId: event.id,
        sessionId: event.sessionId,
        body: encodeTokensToColumn(tokens),
      });
    }
  }

  await insertEventRows(input.connection, eventRows);
  await deleteEventFtsRows(
    input.connection,
    eventRows.map((row) => row.eventId),
  );
  await insertEventFtsRows(input.connection, eventFtsRows);
}

async function insertEventRows(
  connection: SqliteConnection,
  rows: readonly IndexedEventInsertRow[],
): Promise<void> {
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
      params[`sourceUri${index}`] = row.sourceUri;
      params[`sourceSequence${index}`] = String(row.sourceSequence);
      return `(
        $eventId${index},
        $sessionId${index},
        cast($timestamp${index} as real),
        $turn${index},
        $type${index},
        $payloadJson${index},
        $searchText${index},
        $sourceUri${index},
        cast($sourceSequence${index} as integer)
      )`;
    });
    await run(
      connection,
      `
      insert or replace into events (
        event_id, session_id, timestamp, turn, type, payload_json, search_text, source_uri, source_sequence
      ) values ${values.join(", ")}
    `,
      params,
    );
  }
}

async function deleteEventFtsRows(
  connection: SqliteConnection,
  eventIds: readonly string[],
): Promise<void> {
  for (const chunk of chunkArray(uniqueNonEmptyStrings(eventIds), 500)) {
    const params: SqlParams = {};
    const eventFilter = buildInList("event", chunk, params);
    await run(connection, `delete from event_fts where event_id in (${eventFilter})`, params);
  }
}

async function insertEventFtsRows(
  connection: SqliteConnection,
  rows: readonly EventFtsInsertRow[],
): Promise<void> {
  for (const chunk of chunkArray(rows, 500)) {
    const params: SqlParams = {};
    const values = chunk.map((row, index) => {
      params[`eventId${index}`] = row.eventId;
      params[`sessionId${index}`] = row.sessionId;
      params[`body${index}`] = row.body;
      return `($eventId${index}, $sessionId${index}, $body${index})`;
    });
    await run(
      connection,
      `
        insert into event_fts (event_id, session_id, body)
        values ${values.join(", ")}
      `,
      params,
    );
  }
}
