import type { ProtocolRecord } from "./types/foundation.js";

export type UnknownRecord = { readonly [key: string]: unknown };

export function isProtocolRecord(value: unknown): value is ProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: ProtocolRecord, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function optionalStringField(record: ProtocolRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: ProtocolRecord, key: string, fallback: number): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
