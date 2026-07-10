import type { AnyRecord } from "./normalization-shared.js";
import {
  normalizeBoolean,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
} from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

export function normalizeLspConfig(
  lspInput: AnyRecord,
  defaults: BrewvaConfig["lsp"],
): BrewvaConfig["lsp"] {
  return {
    diagnosticsOnApply: normalizeBoolean(lspInput.diagnosticsOnApply, defaults.diagnosticsOnApply),
    inlineBudgetMs: normalizeNonNegativeInteger(lspInput.inlineBudgetMs, defaults.inlineBudgetMs),
    deferredBudgetMs: normalizeNonNegativeInteger(
      lspInput.deferredBudgetMs,
      defaults.deferredBudgetMs,
    ),
    maxMessages: normalizePositiveInteger(lspInput.maxMessages, defaults.maxMessages),
  };
}
