import { tokenizeSearchContent } from "@brewva/brewva-search";
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

export function freshnessFromTimestamp(timestamp: number | undefined): RecallFreshness {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "unknown";
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));
  if (ageDays <= 30) return "fresh";
  if (ageDays <= 180) return "aging";
  return "stale";
}

export function computeTokenOverlap(queryTokens: readonly string[], text: string): number {
  if (queryTokens.length === 0) return 0;
  const textTokens = new Set(tokenizeSearchContent(text));
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.length;
}
