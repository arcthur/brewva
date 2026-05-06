import { tokenizeSearchContent } from "@brewva/brewva-search";
import type { RecallFreshness } from "../types.js";

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

export function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
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
