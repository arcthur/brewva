export const CONTEXT_BUDGET_PRESSURE_LEVELS = ["none", "low", "medium", "high"] as const;

export type ContextBudgetPressure = (typeof CONTEXT_BUDGET_PRESSURE_LEVELS)[number];

export interface ContextState {
  budgetPressure: ContextBudgetPressure;
  promptStabilityFingerprint?: string;
  transientReductionActive: boolean;
  historyBaselineAvailable: boolean;
  reservedPrimaryTokens: number;
  reservedSupplementalTokens: number;
  lastInjectionScopeId?: string;
}

export const DEFAULT_CONTEXT_STATE: ContextState = {
  budgetPressure: "none",
  transientReductionActive: false,
  historyBaselineAvailable: false,
  reservedPrimaryTokens: 0,
  reservedSupplementalTokens: 0,
};
