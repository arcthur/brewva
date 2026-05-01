import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { SessionLifecycleSnapshot } from "../sessions/api.js";

export interface LifecycleSurfaceDependencies {
  getSessionLifecycleSnapshot(sessionId: string): SessionLifecycleSnapshot;
}

export function createLifecycleSurfaceMethods(deps: LifecycleSurfaceDependencies) {
  return {
    getSnapshot: (sessionId: string) => deps.getSessionLifecycleSnapshot(sessionId),
  };
}

export type RuntimeLifecycleSurfaceMethods = ReturnType<typeof createLifecycleSurfaceMethods>;

export const lifecycleSurfaceContribution = {
  inspect: ["getSnapshot"],
} as const satisfies SurfaceContribution<RuntimeLifecycleSurfaceMethods>;

export const lifecycleRuntimeSurface = defineRuntimeSurfaceModule({
  name: "lifecycle",
  createMethods: createLifecycleSurfaceMethods,
  contribution: lifecycleSurfaceContribution,
});
