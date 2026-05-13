import { ParallelBudgetManager as InternalParallelBudgetManager } from "./domain/parallel/api.js";
import { ParallelResultStore as InternalParallelResultStore } from "./domain/parallel/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const PARALLEL_BUDGET_MANAGER_METHODS = [
  "acquire",
  "acquireAsync",
  "release",
  "getActiveRunCount",
  "restoreSession",
  "clear",
] as const satisfies readonly (keyof InstanceType<typeof InternalParallelBudgetManager>)[];
const PARALLEL_RESULT_STORE_METHODS = [
  "record",
  "replace",
  "delete",
  "list",
  "isHydrated",
  "markHydrated",
  "clear",
  "merge",
] as const satisfies readonly (keyof InstanceType<typeof InternalParallelResultStore>)[];

export type ParallelBudgetManager = ExtensionPort<
  "parallel.budget-manager",
  Pick<
    InstanceType<typeof InternalParallelBudgetManager>,
    (typeof PARALLEL_BUDGET_MANAGER_METHODS)[number]
  >
>;
export type ParallelResultStore = ExtensionPort<
  "parallel.result-store",
  Pick<
    InstanceType<typeof InternalParallelResultStore>,
    (typeof PARALLEL_RESULT_STORE_METHODS)[number]
  >
>;

export function createParallelBudgetManager(
  ...args: ConstructorParameters<typeof InternalParallelBudgetManager>
): ParallelBudgetManager {
  return createBoundExtensionPort({
    name: "parallel.budget-manager",
    instance: new InternalParallelBudgetManager(...args),
    methods: PARALLEL_BUDGET_MANAGER_METHODS,
  });
}

export function createParallelResultStore(
  ...args: ConstructorParameters<typeof InternalParallelResultStore>
): ParallelResultStore {
  return createBoundExtensionPort({
    name: "parallel.result-store",
    instance: new InternalParallelResultStore(...args),
    methods: PARALLEL_RESULT_STORE_METHODS,
  });
}
