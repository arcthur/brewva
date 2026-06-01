export type AnyRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(record: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function readPath(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current) || !hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function readRecord(value: unknown, key: string): AnyRecord | undefined {
  const entry = readPath(value, key);
  return isRecord(entry) ? entry : undefined;
}

export function readArray(value: unknown, key: string): unknown[] | undefined {
  const entry = readPath(value, key);
  return Array.isArray(entry) ? entry : undefined;
}

export function readString(value: unknown, key: string): string | undefined {
  const entry = readPath(value, key);
  return typeof entry === "string" ? entry : undefined;
}

export function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === "string") {
      return serialized;
    }
  } catch {
    // fall through
  }
  return "non-serializable error";
}

export function readFiniteNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  const entry = readPath(value, key);
  return typeof entry === "number" ? entry : undefined;
}

export function readFiniteNumber(value: unknown, key: string): number | undefined {
  const entry = readNumber(value, key);
  return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  const entry = readPath(value, key);
  return typeof entry === "boolean" ? entry : undefined;
}

export function asPartialObject<T extends object>(value: unknown): Partial<T> | undefined {
  return isRecord(value) ? (value as Partial<T>) : undefined;
}
