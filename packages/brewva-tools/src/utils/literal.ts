export function readLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}
