export function resolveDefaultExport<T>(value: unknown): T | undefined {
  if (typeof value === "object" && value !== null && "default" in value) {
    return (value as { default?: T }).default;
  }
  return value as T;
}
