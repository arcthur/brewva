import { coerceReviewReportArtifact } from "../skills/review-normalization.js";
import type { WorkflowArtifact } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (isRecord(entry)) {
        return readString(entry.path) ?? readString(entry.file) ?? readString(entry.name) ?? "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
}

export function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function compactJsonValue(value: unknown, maxChars = 220): string | undefined {
  if (typeof value === "string") {
    return compactText(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const pieces = value
      .map((entry) => compactJsonValue(entry, Math.max(40, Math.floor(maxChars / 3))))
      .filter((entry): entry is string => Boolean(entry));
    if (pieces.length === 0) return undefined;
    return compactText(pieces.join("; "), maxChars);
  }
  if (isRecord(value)) {
    try {
      return compactText(JSON.stringify(value), maxChars);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function summarizeReviewReport(value: unknown, maxChars = 220): string | undefined {
  if (isRecord(value)) {
    const summary = readString(value.summary);
    if (summary) {
      return compactText(summary, maxChars);
    }
  }
  const structured = coerceReviewReportArtifact(value);
  if (structured) {
    return compactText(structured.summary, maxChars);
  }
  return compactJsonValue(value, maxChars);
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function formatPreviewList(values: readonly string[], limit = 3): string {
  if (values.length === 0) return "none";
  const preview = values.slice(0, limit);
  if (values.length <= limit) return preview.join(", ");
  return `${preview.join(", ")} (+${values.length - limit} more)`;
}

export function buildNormalizationBlockerMessage(
  label: string,
  artifact: WorkflowArtifact | undefined,
): string | undefined {
  if (!artifact || !artifact.metadata) {
    return undefined;
  }
  const unresolved = readStringArray(artifact.metadata.unresolved);
  if (unresolved.length === 0) {
    return undefined;
  }
  return artifact.state === "pending"
    ? `${label} is partial and still needs normalized fields: ${formatPreviewList(unresolved)}.`
    : artifact.state === "blocked"
      ? `${label} has unresolved normalized fields: ${formatPreviewList(unresolved)}.`
      : undefined;
}
