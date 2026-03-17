export function normalizeOptionalString(value: unknown): string | null;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue: undefined;
  },
): string | undefined;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue: null;
  },
): string | null;
export function normalizeOptionalString(
  value: unknown,
  options: {
    emptyValue?: null | undefined;
  } = {},
): string | null | undefined {
  if (typeof value !== "string") {
    return options.emptyValue ?? null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : (options.emptyValue ?? null);
}
