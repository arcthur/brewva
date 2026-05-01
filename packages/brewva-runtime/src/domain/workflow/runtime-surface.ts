import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";

export interface RuntimeWorkflowSurfaceMethods {}

export const workflowSurfaceContribution =
  {} as const satisfies SurfaceContribution<RuntimeWorkflowSurfaceMethods>;

export function createWorkflowSurfaceMethods(): RuntimeWorkflowSurfaceMethods {
  return {};
}

export const workflowRuntimeSurface = defineRuntimeSurfaceModule({
  name: "workflow",
  createMethods: createWorkflowSurfaceMethods,
  contribution: workflowSurfaceContribution,
});
