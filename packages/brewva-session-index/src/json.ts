import { readStringList } from "@brewva/brewva-std/text";
import { isRecord, readTrimmedString } from "@brewva/brewva-std/unknown";

export function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  try {
    const parsed = JSON.parse(value) as unknown;
    return readStringList(parsed);
  } catch {
    return [];
  }
}

export { isRecord };
