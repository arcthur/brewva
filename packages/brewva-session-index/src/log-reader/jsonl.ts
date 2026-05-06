import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { isRecord, normalizePayload } from "../json.js";

const LOG_READ_CHUNK_BYTES = 64 * 1024;

export interface ParsedLogEvent {
  event: BrewvaEventRecord;
  logOffset: number;
}

export interface ReadLogResult {
  events: ParsedLogEvent[];
  nextOffset: number;
}

export function readEventsFromLog(
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
