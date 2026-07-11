export interface TruncateTextOptions {
  marker?: string;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Rewrite Windows-style `\` path separators to POSIX `/`. A pure string
 * transform (no filesystem access) — the std home for the `replaceAll("\\", "/")`
 * separator normalization that several packages had grown private copies of.
 * Callers that also strip a leading `./`, trim, or lowercase should compose those
 * on top of this rather than re-inline the separator swap. When the input is an
 * absolute or resolved path that must first be made relative, use
 * `relativePosixPath` from `@brewva/brewva-std/node/fs`.
 */
export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function truncateText(
  value: string,
  maxChars: number,
  options: TruncateTextOptions = {},
): string {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative integer");
  }
  if (value.length <= maxChars) return value;
  const marker = options.marker ?? "";
  if (marker.length > 0) {
    if (marker.length >= maxChars) return marker.slice(0, maxChars);
    return `${value.slice(0, maxChars - marker.length)}${marker}`;
  }
  return value.slice(0, maxChars);
}

export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeStringList(value: unknown): string[] {
  return readStringList(value)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeLowercaseStringList(value: unknown): string[] {
  return normalizeStringList(value).map((entry) => entry.toLowerCase());
}

export function stripUnpairedSurrogates(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] ?? "";
        output += value[index + 1] ?? "";
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }
    output += value[index] ?? "";
  }
  return output;
}
