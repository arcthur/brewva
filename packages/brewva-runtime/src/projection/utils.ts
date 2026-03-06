import type { ProjectionSourceRef } from "./types.js";

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function sourceRefKey(ref: ProjectionSourceRef): string {
  return [ref.eventId, ref.eventType, ref.sessionId, ref.evidenceId ?? ""].join("::");
}

export function mergeSourceRefs(
  current: ProjectionSourceRef[],
  incoming: ProjectionSourceRef[],
): ProjectionSourceRef[] {
  const merged = new Map<string, ProjectionSourceRef>();
  for (const ref of current) {
    merged.set(sourceRefKey(ref), ref);
  }
  for (const ref of incoming) {
    merged.set(sourceRefKey(ref), ref);
  }
  return [...merged.values()].toSorted((left, right) => left.timestamp - right.timestamp);
}
