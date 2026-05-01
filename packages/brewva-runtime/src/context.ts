import { ContextArena as InternalContextArena } from "./domain/context/api.js";
import { ContextBudgetManager as InternalContextBudgetManager } from "./domain/context/api.js";
import { ContextInjectionCollector as InternalContextInjectionCollector } from "./domain/context/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const CONTEXT_ARENA_METHODS = [
  "append",
  "plan",
  "markPresented",
  "clearPending",
  "clearSession",
  "snapshot",
] as const satisfies readonly (keyof InstanceType<typeof InternalContextArena>)[];
const CONTEXT_BUDGET_MANAGER_METHODS = [
  "beginTurn",
  "observeUsage",
  "getEffectivePolicy",
  "getEffectiveInjectionTokenBudget",
  "getEffectiveCompactionThresholdPercent",
  "getEffectiveHardLimitPercent",
  "planInjection",
  "shouldRequestCompaction",
  "markCompacted",
  "requestCompaction",
  "getPendingCompactionReason",
  "getLastContextUsage",
  "getLastCompactionTurn",
  "clear",
  "getCompactionInstructions",
] as const satisfies readonly (keyof InstanceType<typeof InternalContextBudgetManager>)[];
const CONTEXT_INJECTION_COLLECTOR_METHODS = [
  "register",
  "plan",
  "commit",
  "consume",
  "clearPending",
  "onCompaction",
  "clearSession",
] as const satisfies readonly (keyof InstanceType<typeof InternalContextInjectionCollector>)[];

export type ContextArena = ExtensionPort<
  "context.arena",
  "context",
  Pick<InstanceType<typeof InternalContextArena>, (typeof CONTEXT_ARENA_METHODS)[number]>
>;
export type ContextBudgetManager = ExtensionPort<
  "context.budget-manager",
  "context",
  Pick<
    InstanceType<typeof InternalContextBudgetManager>,
    (typeof CONTEXT_BUDGET_MANAGER_METHODS)[number]
  >
>;
export type ContextInjectionCollector = ExtensionPort<
  "context.injection-collector",
  "context",
  Pick<
    InstanceType<typeof InternalContextInjectionCollector>,
    (typeof CONTEXT_INJECTION_COLLECTOR_METHODS)[number]
  >
>;
export type { ContextInjectionEntry } from "./domain/context/api.js";

export function createContextArena(
  ...args: ConstructorParameters<typeof InternalContextArena>
): ContextArena {
  return createBoundExtensionPort({
    name: "context.arena",
    authority: "context",
    capabilityPrefix: "subpath.context.arena",
    instance: new InternalContextArena(...args),
    methods: CONTEXT_ARENA_METHODS,
  });
}

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

export function createContextInjectionCollector(
  ...args: ConstructorParameters<typeof InternalContextInjectionCollector>
): ContextInjectionCollector {
  return createBoundExtensionPort({
    name: "context.injection-collector",
    authority: "context",
    capabilityPrefix: "subpath.context.injection-collector",
    instance: new InternalContextInjectionCollector(...args),
    methods: CONTEXT_INJECTION_COLLECTOR_METHODS,
  });
}
