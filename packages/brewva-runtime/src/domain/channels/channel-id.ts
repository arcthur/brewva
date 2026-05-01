export function normalizeChannelId(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return normalized;
}
