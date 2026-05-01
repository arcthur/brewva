import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeDelegationSurfaceMethods {}

export const delegationSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeDelegationSurfaceMethods>;

export function createDelegationSurfaceMethods(): RuntimeDelegationSurfaceMethods {
  return {};
}

export const delegationRuntimeSurface = defineRuntimeSurfaceModule({
  name: "delegation",
  createMethods: createDelegationSurfaceMethods,
  contribution: delegationSurfaceContribution,
});
