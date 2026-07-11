import { safeParseJson } from "@brewva/brewva-std/json";
import { readStringList } from "@brewva/brewva-std/text";
import { isRecord, readTrimmedString } from "@brewva/brewva-std/unknown";

export function parsePayload(value: string): Record<string, unknown> {
  const parsed = safeParseJson(value);
  return isRecord(parsed) ? parsed : {};
}

export function normalizePayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function readString(value: unknown): string | undefined {
  return readTrimmedString(value);
}

export function normalizeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function parseStringArray(value: string): string[] {
  return readStringList(safeParseJson(value));
}

export { isRecord };
