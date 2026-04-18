export type AnyRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return fallback;
  return Math.floor(value);
}

export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function normalizeUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function normalizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeLowercaseStringArray(value: unknown, fallback: string[]): string[] {
  const normalized = normalizeStringArray(value, fallback)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set(normalized)];
}

export function normalizePositiveIntegerArray(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const normalized = value
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .map((entry) => Math.floor(entry))
    .filter((entry) => entry > 0);
  return [...new Set(normalized)];
}

export function normalizeStrictStringEnum<T extends string>(
  value: unknown,
  fallback: T,
  validSet: Set<string>,
  fieldPath: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new Error(
      `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received non-string.`,
    );
  }
  const normalized = value.trim();
  if (validSet.has(normalized)) {
    return normalized as T;
  }
  throw new Error(
    `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received "${value}".`,
  );
}

export function normalizeStringRecord(
  value: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!isRecord(value)) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out[key] = entry;
  }
  return out;
}
