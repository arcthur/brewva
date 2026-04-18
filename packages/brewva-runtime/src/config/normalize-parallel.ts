import type { BrewvaConfig } from "../contracts/index.js";
import type { AnyRecord } from "./normalization-shared.js";
import { normalizeBoolean, normalizePositiveInteger } from "./normalization-shared.js";

export function normalizeParallelConfig(
  parallelInput: AnyRecord,
  defaults: BrewvaConfig["parallel"],
): BrewvaConfig["parallel"] {
  return {
    enabled: normalizeBoolean(parallelInput.enabled, defaults.enabled),
    maxConcurrent: normalizePositiveInteger(parallelInput.maxConcurrent, defaults.maxConcurrent),
    maxTotalPerSession: normalizePositiveInteger(
      parallelInput.maxTotalPerSession,
      defaults.maxTotalPerSession,
    ),
  };
}
