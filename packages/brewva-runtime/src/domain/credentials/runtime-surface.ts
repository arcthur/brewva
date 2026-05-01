import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeCredentialsSurfaceMethods {}

export const credentialsSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeCredentialsSurfaceMethods>;

export function createCredentialsSurfaceMethods(): RuntimeCredentialsSurfaceMethods {
  return {};
}

export const credentialsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "credentials",
  createMethods: createCredentialsSurfaceMethods,
  contribution: credentialsSurfaceContribution,
});
