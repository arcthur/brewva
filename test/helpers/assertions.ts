export function requireDefined<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

export function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, message: string): string {
  const text = requireString(value, message);
  if (text.length === 0) {
    throw new Error(message);
  }
  return text;
}

export function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(message);
  }
  return value;
}

export function requireArray<T = unknown>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value as T[];
}
