import type { BrewvaEventRecord } from "@brewva/brewva-runtime/protocol";
import { chunkArray, uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type { DuckDBConnection } from "../duckdb/instance.js";
import {
  buildSessionIndexEventSearchText,
  isSessionIndexTextIndexedEvent,
} from "../evidence/index.js";
import { buildEventSearchTokenRows, type IndexedEventTokenInsertRow } from "../evidence/tokens.js";
import { buildInList, type SqlParams } from "../sql/params.js";
import type { IndexedEventInsertRow } from "./rows.js";

export interface ParsedSessionIndexEvent {
  event: BrewvaEventRecord;
  sequence: number;
}

export async function upsertSessionEvents(input: {
  connection: DuckDBConnection;
  sourceUri: string;
  parsedEvents: readonly ParsedSessionIndexEvent[];
}): Promise<void> {
  if (input.parsedEvents.length === 0) return;

  const eventRows: IndexedEventInsertRow[] = [];
  const eventTokenRows: IndexedEventTokenInsertRow[] = [];
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
    eventTokenRows.push(
      ...buildEventSearchTokenRows({
        eventId: event.id,
        sessionId: event.sessionId,
        type: event.type,
        timestamp: event.timestamp,
        searchText,
      }),
    );
  }

  await insertEventRows(input.connection, eventRows);
  await deleteEventTokens(
    input.connection,
    eventRows.map((row) => row.eventId),
  );
  await insertEventTokenRows(input.connection, eventTokenRows);
}

async function insertEventRows(
  connection: DuckDBConnection,
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
        cast($timestamp${index} as double),
        $turn${index},
        $type${index},
        $payloadJson${index},
        $searchText${index},
        $sourceUri${index},
        cast($sourceSequence${index} as bigint)
      )`;
    });
    await connection.run(
      `
      insert or replace into events (
        event_id, session_id, timestamp, turn, type, payload_json, search_text, source_uri, source_sequence
      ) values ${values.join(", ")}
    `,
      params,
    );
  }
}

async function deleteEventTokens(
  connection: DuckDBConnection,
  eventIds: readonly string[],
): Promise<void> {
  for (const chunk of chunkArray(uniqueNonEmptyStrings(eventIds), 500)) {
    const params: SqlParams = {};
    const eventFilter = buildInList("event", chunk, params);
    await connection.run(`delete from event_tokens where event_id in (${eventFilter})`, params);
  }
}

async function insertEventTokenRows(
  connection: DuckDBConnection,
  rows: readonly IndexedEventTokenInsertRow[],
): Promise<void> {
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
    await connection.run(
      `
        insert into event_tokens (token, event_id, session_id, type, timestamp)
        values ${values.join(", ")}
      `,
      params,
    );
  }
}
