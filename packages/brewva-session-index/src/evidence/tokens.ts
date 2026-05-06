import { tokenizeSearchContent } from "@brewva/brewva-search";
import { uniqueStrings } from "../collections.js";

export interface IndexedEventTokenInsertRow {
  token: string;
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: number;
}

export interface SessionTokenInsertRow {
  token: string;
  sessionId: string;
  sourceField: string;
}

export function buildEventSearchTokenRows(input: {
  eventId: string;
  sessionId: string;
  type: string;
  timestamp: number;
  searchText: string;
}): IndexedEventTokenInsertRow[] {
  if (!input.searchText.trim()) {
    return [];
  }
  return uniqueStrings(tokenizeSearchContent(input.searchText)).map((token) => ({
    token,
    eventId: input.eventId,
    sessionId: input.sessionId,
    type: input.type,
    timestamp: input.timestamp,
  }));
}

export function buildSessionFieldTokenRows(input: {
  sessionId: string;
  sourceField: string;
  value: string;
}): SessionTokenInsertRow[] {
  return uniqueStrings(tokenizeSearchContent(input.value)).map((token) => ({
    token,
    sessionId: input.sessionId,
    sourceField: input.sourceField,
  }));
}
