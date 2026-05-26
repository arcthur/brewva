import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";

export function readRecord(value: unknown): ProtocolRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ProtocolRecord)
    : {};
}

export function readNumber(record: ProtocolRecord, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeWindowCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : null;
}

export function sliceWindow<T>(values: T[], offset: number | null, limit: number | null): T[] {
  let window = values;
  if (offset !== null && offset > 0) {
    window = window.slice(offset);
  }
  if (limit !== null) {
    window = window.slice(0, limit);
  }
  return window;
}

export function knownRuntimeEventSessionIds(input: {
  readonly listSessionIds?: () => readonly string[];
  readonly listRuntimeEventSessionIds?: () => readonly string[];
}): string[] {
  return [
    ...new Set([
      ...(input.listSessionIds?.() ?? []),
      ...(input.listRuntimeEventSessionIds?.() ?? []),
    ]),
  ].toSorted();
}
