import type { AnyRecord } from "./normalization-shared.js";
import { normalizeBoolean } from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

export function normalizeUiConfig(
  uiInput: AnyRecord,
  defaults: BrewvaConfig["ui"],
): BrewvaConfig["ui"] {
  return {
    quietStartup: normalizeBoolean(uiInput.quietStartup, defaults.quietStartup),
  };
}
