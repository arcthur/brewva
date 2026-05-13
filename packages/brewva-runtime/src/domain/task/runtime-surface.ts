import type { TaskService } from "./task.js";
import type { TaskItemStatus, TaskSpec, TaskState, TaskTargetDescriptor } from "./types.js";

export interface TaskSurfaceDependencies {
  getTaskService(): TaskService;
  getTaskTargetDescriptor(sessionId: string): TaskTargetDescriptor;
  getTaskState(sessionId: string): TaskState;
}

export function createTaskSurfaceMethods(deps: TaskSurfaceDependencies) {
  return {
    authority: {
      spec: {
        set: (sessionId: string, spec: TaskSpec) =>
          deps.getTaskService().setTaskSpec(sessionId, spec),
      },
      items: {
        add: (sessionId: string, input: { text: string; status?: TaskItemStatus; id?: string }) =>
          deps.getTaskService().addTaskItem(sessionId, input),
        update: (
          sessionId: string,
          input: { id: string; text?: string; status?: TaskItemStatus },
        ) => deps.getTaskService().updateTaskItem(sessionId, input),
      },
      blockers: {
        record: (
          sessionId: string,
          input: {
            id?: string;
            message: string;
            source?: string;
            claimId?: string;
          },
        ) => deps.getTaskService().recordTaskBlocker(sessionId, input),
        resolve: (sessionId: string, blockerId: string) =>
          deps.getTaskService().resolveTaskBlocker(sessionId, blockerId),
      },
      acceptance: {
        record: (
          sessionId: string,
          input: {
            status: "pending" | "accepted" | "rejected";
            decidedBy?: string;
            notes?: string;
          },
        ) => deps.getTaskService().recordTaskAcceptance(sessionId, input),
      },
    },
    inspect: {
      target: {
        getDescriptor: (sessionId: string) => deps.getTaskTargetDescriptor(sessionId),
      },
      state: {
        get: (sessionId: string) => deps.getTaskState(sessionId),
      },
    },
  };
}

export type RuntimeTaskSurfaceMethods = ReturnType<typeof createTaskSurfaceMethods>;

export function createTaskAuthoritySurface(deps: TaskSurfaceDependencies) {
  return createTaskSurfaceMethods(deps).authority;
}

export function createTaskInspectSurface(deps: TaskSurfaceDependencies) {
  return createTaskSurfaceMethods(deps).inspect;
}
