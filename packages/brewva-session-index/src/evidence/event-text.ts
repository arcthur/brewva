import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { isRecord } from "../json.js";
import { compactText } from "../text.js";

export function buildSessionIndexEventSearchText(event: BrewvaEventRecord): string {
  const parts: string[] = [event.type];
  if (isRecord(event.payload)) {
    const leaves: string[] = [];
    collectStringLeaves(event.payload, leaves);
    parts.push(...leaves.slice(0, 8));
  }
  return compactText(parts.join(" "), 600);
}

function collectStringLeaves(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) {
      sink.push(normalized);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, sink);
    }
    return;
  }
  // Intentionally follows TypeBox payload key declaration order; schema field
  // reordering will quietly change which text leaves are indexed first.
  for (const entry of Object.values(value)) {
    collectStringLeaves(entry, sink);
  }
}
