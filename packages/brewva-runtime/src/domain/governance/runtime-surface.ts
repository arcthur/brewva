import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeGovernanceSurfaceMethods {}

export const governanceSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeGovernanceSurfaceMethods>;

export function createGovernanceSurfaceMethods(): RuntimeGovernanceSurfaceMethods {
  return {};
}

export const governanceRuntimeSurface = defineRuntimeSurfaceModule({
  name: "governance",
  createMethods: createGovernanceSurfaceMethods,
  contribution: governanceSurfaceContribution,
});
