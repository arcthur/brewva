import { chunk, unique } from "remeda";

export function uniqueValues<T>(values: readonly T[]): T[] {
  return Array.from(unique(values));
}

export function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  return uniqueValues(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

export function sortedUniqueStrings(values: readonly string[]): string[] {
  return uniqueNonEmptyStrings(values).toSorted();
}

export function chunkArray<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError("size must be a positive integer");
  }
  return chunk(values, size).map((entry) => Array.from(entry));
}

export function compactDefinedRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Exclude<T[keyof T], undefined>] => {
      return entry[1] !== undefined;
    }),
  ) as Partial<T>;
}

export function compactNonNullishRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, NonNullable<T[keyof T]>] => {
      return entry[1] !== null && entry[1] !== undefined;
    }),
  ) as Partial<T>;
}

export function indexByLast<T, K extends PropertyKey>(
  values: readonly T[],
  key: (value: T) => K,
): Map<K, T> {
  const indexed = new Map<K, T>();
  for (const value of values) {
    indexed.set(key(value), value);
  }
  return indexed;
}

export function countByKey<T, K extends PropertyKey>(
  values: readonly T[],
  key: (value: T) => K,
): Record<K, number> {
  const counts = Object.create(null) as Record<K, number>;
  for (const value of values) {
    const entryKey = key(value);
    counts[entryKey] = (counts[entryKey] ?? 0) + 1;
  }
  return counts;
}
