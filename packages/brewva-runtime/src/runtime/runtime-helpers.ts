import { formatTaskStateBlock } from "../domain/task/api.js";
import type { TaskState } from "../domain/task/api.js";
import { getBrewvaEventCategory } from "../events/registry.js";
import type { BrewvaEventCategory } from "../events/types.js";

export function inferEventCategory(type: string): BrewvaEventCategory {
  return getBrewvaEventCategory(type) ?? "other";
}

export function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}
