import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeEvidenceSurfaceMethods {}

export const evidenceSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeEvidenceSurfaceMethods>;

export function createEvidenceSurfaceMethods(): RuntimeEvidenceSurfaceMethods {
  return {};
}

export const evidenceRuntimeSurface = defineRuntimeSurfaceModule({
  name: "evidence",
  createMethods: createEvidenceSurfaceMethods,
  contribution: evidenceSurfaceContribution,
});
