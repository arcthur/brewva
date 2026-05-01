import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { CostService } from "./cost.js";

export interface CostSurfaceDependencies {
  getCostService(): CostService;
}

export function createCostSurfaceMethods(deps: CostSurfaceDependencies) {
  return {
    recordAssistantUsage: (input: Parameters<CostService["recordAssistantUsage"]>[0]) =>
      deps.getCostService().recordAssistantUsage(input),
    getSummary: (sessionId: string) => deps.getCostService().getCostSummary(sessionId),
  };
}

export type RuntimeCostSurfaceMethods = ReturnType<typeof createCostSurfaceMethods>;

export const costSurfaceContribution = {
  authority: ["recordAssistantUsage"],
  inspect: ["getSummary"],
} as const satisfies SurfaceContribution<RuntimeCostSurfaceMethods>;

export const costRuntimeSurface = defineRuntimeSurfaceModule({
  name: "cost",
  createMethods: createCostSurfaceMethods,
  contribution: costSurfaceContribution,
});
