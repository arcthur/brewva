import type { CostService } from "./cost.js";

export interface CostSurfaceDependencies {
  getCostService(): CostService;
}

export function createCostSurfaceMethods(deps: CostSurfaceDependencies) {
  return {
    usage: {
      recordAssistant: (input: Parameters<CostService["recordAssistantUsage"]>[0]) =>
        deps.getCostService().recordAssistantUsage(input),
    },
    summary: {
      get: (sessionId: string) => deps.getCostService().getCostSummary(sessionId),
    },
  };
}

export type RuntimeCostSurfaceMethods = ReturnType<typeof createCostSurfaceMethods>;

export function createCostAuthoritySurface(deps: CostSurfaceDependencies) {
  const methods = createCostSurfaceMethods(deps);
  return {
    usage: methods.usage,
  };
}

export function createCostInspectSurface(deps: CostSurfaceDependencies) {
  const methods = createCostSurfaceMethods(deps);
  return {
    summary: methods.summary,
  };
}
