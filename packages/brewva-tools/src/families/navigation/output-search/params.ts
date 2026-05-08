export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizePositiveInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function normalizeOptionalQueryList(params: {
  query?: unknown;
  queries?: unknown;
}): string[] {
  const queryList: string[] = [];
  const single = normalizeText(params.query);
  if (single) queryList.push(single);

  if (Array.isArray(params.queries)) {
    for (const item of params.queries) {
      const value = normalizeText(item);
      if (value) queryList.push(value);
    }
  }

  return [...new Set(queryList)];
}

export function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

export function clampOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(32, maxChars - 64);
  return `${text.slice(0, keep)}\n...[output truncated due to max_output_chars]`;
}
