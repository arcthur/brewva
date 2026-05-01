import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeParallelSurfaceMethods {}

export const parallelSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeParallelSurfaceMethods>;

export function createParallelSurfaceMethods(): RuntimeParallelSurfaceMethods {
  return {};
}

export const parallelRuntimeSurface = defineRuntimeSurfaceModule({
  name: "parallel",
  createMethods: createParallelSurfaceMethods,
  contribution: parallelSurfaceContribution,
});
