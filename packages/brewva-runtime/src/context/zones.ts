export type ContextZone =
  | "identity"
  | "truth"
  | "task_state"
  | "tool_failures"
  | "memory_working"
  | "memory_recall";

export const ZONE_ORDER: ContextZone[] = [
  "identity",
  "truth",
  "task_state",
  "tool_failures",
  "memory_working",
  "memory_recall",
];

const SOURCE_TO_ZONE: Record<string, ContextZone> = {
  "brewva.identity": "identity",
  "brewva.truth-static": "truth",
  "brewva.truth-facts": "truth",
  "brewva.task-state": "task_state",
  "brewva.tool-failures": "tool_failures",
  "brewva.memory-working": "memory_working",
  "brewva.memory-recall": "memory_recall",
};

export function zoneForSource(source: string): ContextZone {
  return SOURCE_TO_ZONE[source] ?? "memory_recall";
}

export function zoneOrderIndex(zone: ContextZone): number {
  const index = ZONE_ORDER.indexOf(zone);
  return index >= 0 ? index : ZONE_ORDER.length;
}
