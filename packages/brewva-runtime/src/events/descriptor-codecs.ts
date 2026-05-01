import type { JsonValue } from "../utils/json.js";
import { toJsonValue } from "../utils/json.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readNullableString(value: unknown): string | null {
  return value === null ? null : readString(value);
}

export function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => entry !== null);
}

export function readJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, toJsonValue(entry)]),
  ) as Record<string, JsonValue>;
}
