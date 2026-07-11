import {
  compactWhitespace,
  normalizeStringList,
  readNonEmptyString,
  truncateText,
} from "@brewva/brewva-std/text";
import type { RecallFreshness } from "../types.js";

export function readString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

export function readStringArray(value: unknown): string[] {
  return normalizeStringList(value);
}

export function compactText(value: string, maxChars = 220): string {
  return truncateText(compactWhitespace(value), maxChars, { marker: "..." });
}

// Calibration-eligible (calibration parameter registry): a tape/session-memory
// entry ages in weeks — deliberately shorter than the knowledge-doc scale.
export const RECALL_TAPE_FRESH_MAX_DAYS = 30;
export const RECALL_TAPE_AGING_MAX_DAYS = 180;

export function freshnessFromTimestamp(timestamp: number | undefined): RecallFreshness {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "unknown";
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (ageDays <= RECALL_TAPE_FRESH_MAX_DAYS) return "fresh";
  if (ageDays <= RECALL_TAPE_AGING_MAX_DAYS) return "aging";
  return "stale";
}
