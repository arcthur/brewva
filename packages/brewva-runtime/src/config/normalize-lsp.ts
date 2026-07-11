import type { AnyRecord } from "./normalization-shared.js";
import { normalizeBoolean } from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

export function normalizeLspConfig(
  lspInput: AnyRecord,
  defaults: BrewvaConfig["lsp"],
): BrewvaConfig["lsp"] {
  return {
    diagnosticsOnApply: normalizeBoolean(lspInput.diagnosticsOnApply, defaults.diagnosticsOnApply),
  };
}
