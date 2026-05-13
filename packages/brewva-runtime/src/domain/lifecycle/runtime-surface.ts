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

export function createLifecycleInspectSurface(deps: LifecycleSurfaceDependencies) {
  return createLifecycleSurfaceMethods(deps);
}
