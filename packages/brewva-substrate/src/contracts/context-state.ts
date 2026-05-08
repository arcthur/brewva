export const CONTEXT_BUDGET_PRESSURE_LEVELS = ["none", "low", "medium", "high"] as const;

export type ContextBudgetPressure = (typeof CONTEXT_BUDGET_PRESSURE_LEVELS)[number];

export interface ContextState {
  budgetPressure: ContextBudgetPressure;
  promptStabilityFingerprint?: string;
  transientReductionActive: boolean;
  historyBaselineAvailable: boolean;
}

export const DEFAULT_CONTEXT_STATE: ContextState = {
  budgetPressure: "none",
  transientReductionActive: false,
  historyBaselineAvailable: false,
};
