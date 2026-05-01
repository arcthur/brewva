import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeIterationSurfaceMethods {}

export const iterationSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeIterationSurfaceMethods>;

export function createIterationSurfaceMethods(): RuntimeIterationSurfaceMethods {
  return {};
}

export const iterationRuntimeSurface = defineRuntimeSurfaceModule({
  name: "iteration",
  createMethods: createIterationSurfaceMethods,
  contribution: iterationSurfaceContribution,
});
