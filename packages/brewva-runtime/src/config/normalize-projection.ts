import type { BrewvaConfig } from "../contracts/index.js";
import type { AnyRecord } from "./normalization-shared.js";
import {
  normalizeBoolean,
  normalizeNonEmptyString,
  normalizePositiveInteger,
} from "./normalization-shared.js";

export function normalizeProjectionConfig(
  projectionInput: AnyRecord,
  defaults: BrewvaConfig["projection"],
): BrewvaConfig["projection"] {
  return {
    enabled: normalizeBoolean(projectionInput.enabled, defaults.enabled),
    dir: normalizeNonEmptyString(projectionInput.dir, defaults.dir),
    workingFile: normalizeNonEmptyString(projectionInput.workingFile, defaults.workingFile),
    maxWorkingChars: normalizePositiveInteger(
      projectionInput.maxWorkingChars,
      defaults.maxWorkingChars,
    ),
  };
}
