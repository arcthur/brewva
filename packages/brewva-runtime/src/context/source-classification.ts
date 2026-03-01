import { DROP_RECALL_DEGRADABLE_SOURCES } from "./sources.js";

const dropRecallDegradableSourceSet = new Set<string>(DROP_RECALL_DEGRADABLE_SOURCES);

export function isDropRecallDegradableSource(source: string): boolean {
  return dropRecallDegradableSourceSet.has(source);
}
