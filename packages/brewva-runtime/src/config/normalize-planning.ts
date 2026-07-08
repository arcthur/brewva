import type { AnyRecord } from "./normalization-shared.js";
import { normalizeBoolean } from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

export function normalizePlanningConfig(
  planningInput: AnyRecord,
  defaults: BrewvaConfig["planning"],
): BrewvaConfig["planning"] {
  return {
    mapEnabled: normalizeBoolean(planningInput.mapEnabled, defaults.mapEnabled),
  };
}
