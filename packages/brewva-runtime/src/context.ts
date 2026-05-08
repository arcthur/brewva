import { ContextBudgetManager as InternalContextBudgetManager } from "./domain/context/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const CONTEXT_BUDGET_MANAGER_METHODS = [
  "beginTurn",
  "observeUsage",
  "getEffectivePolicy",
  "getEffectiveCompactionThresholdPercent",
  "getEffectiveHardLimitPercent",
  "getEffectiveDynamicTailTokenBudget",
  "planDynamicTailAdmission",
  "shouldRequestCompaction",
  "markCompacted",
  "requestCompaction",
  "getPendingCompactionReason",
  "getLastContextUsage",
  "getLastCompactionTurn",
  "clear",
  "getCompactionInstructions",
] as const satisfies readonly (keyof InstanceType<typeof InternalContextBudgetManager>)[];
export type ContextBudgetManager = ExtensionPort<
  "context.budget-manager",
  "context",
  Pick<
    InstanceType<typeof InternalContextBudgetManager>,
    (typeof CONTEXT_BUDGET_MANAGER_METHODS)[number]
  >
>;

export function createContextBudgetManager(
  ...args: ConstructorParameters<typeof InternalContextBudgetManager>
): ContextBudgetManager {
  return createBoundExtensionPort({
    name: "context.budget-manager",
    authority: "context",
    capabilityPrefix: "subpath.context.budget-manager",
    instance: new InternalContextBudgetManager(...args),
    methods: CONTEXT_BUDGET_MANAGER_METHODS,
  });
}
