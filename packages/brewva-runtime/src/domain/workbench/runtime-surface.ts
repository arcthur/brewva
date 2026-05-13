import type { WorkbenchService } from "./service.js";

export interface WorkbenchSurfaceDependencies {
  getWorkbenchService(): WorkbenchService;
}

export function createWorkbenchSurfaceMethods(deps: WorkbenchSurfaceDependencies) {
  return {
    list: (sessionId: string) => deps.getWorkbenchService().list(sessionId),
    note: (sessionId: string, input: Parameters<WorkbenchService["note"]>[1]) =>
      deps.getWorkbenchService().note(sessionId, input),
    evict: (sessionId: string, input: Parameters<WorkbenchService["evict"]>[1]) =>
      deps.getWorkbenchService().evict(sessionId, input),
    undoEviction: (sessionId: string, entryId: string, reason?: string) =>
      deps.getWorkbenchService().undoEviction(sessionId, entryId, reason),
    commitBaseline: (sessionId: string) => deps.getWorkbenchService().commitBaseline(sessionId),
  };
}

export type RuntimeWorkbenchSurfaceMethods = ReturnType<typeof createWorkbenchSurfaceMethods>;

export function createWorkbenchAuthoritySurface(deps: WorkbenchSurfaceDependencies) {
  const methods = createWorkbenchSurfaceMethods(deps);
  return {
    note: methods.note,
    evict: methods.evict,
    undoEviction: methods.undoEviction,
    commitBaseline: methods.commitBaseline,
  };
}

export function createWorkbenchInspectSurface(deps: WorkbenchSurfaceDependencies) {
  const methods = createWorkbenchSurfaceMethods(deps);
  return {
    list: methods.list,
  };
}
