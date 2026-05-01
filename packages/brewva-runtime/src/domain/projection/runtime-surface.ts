import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeProjectionSurfaceMethods {}

export const projectionSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeProjectionSurfaceMethods>;

export function createProjectionSurfaceMethods(): RuntimeProjectionSurfaceMethods {
  return {};
}

export const projectionRuntimeSurface = defineRuntimeSurfaceModule({
  name: "projection",
  createMethods: createProjectionSurfaceMethods,
  contribution: projectionSurfaceContribution,
});
