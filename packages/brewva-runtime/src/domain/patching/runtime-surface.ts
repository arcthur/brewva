import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimePatchingSurfaceMethods {}

export const patchingSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimePatchingSurfaceMethods>;

export function createPatchingSurfaceMethods(): RuntimePatchingSurfaceMethods {
  return {};
}

export const patchingRuntimeSurface = defineRuntimeSurfaceModule({
  name: "patching",
  createMethods: createPatchingSurfaceMethods,
  contribution: patchingSurfaceContribution,
});
