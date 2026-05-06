export function parseTapeStableId(
  stableId: string,
): { sessionId: string; eventId: string } | undefined {
  if (!stableId.startsWith("tape:")) {
    return undefined;
  }
  const encoded = stableId.slice("tape:".length);
  const splitIndex = encoded.lastIndexOf(":");
  if (splitIndex <= 0 || splitIndex >= encoded.length - 1) {
    return undefined;
  }
  return {
    sessionId: encoded.slice(0, splitIndex),
    eventId: encoded.slice(splitIndex + 1),
  };
}
