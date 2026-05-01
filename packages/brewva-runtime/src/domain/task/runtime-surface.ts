import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { TaskService } from "./task.js";
import type {
  TaskAcceptanceRecordResult,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskSpec,
  TaskState,
  TaskTargetDescriptor,
} from "./types.js";

export interface TaskSurfaceDependencies {
  getTaskService(): TaskService;
  getTaskTargetDescriptor(sessionId: string): TaskTargetDescriptor;
  getTaskState(sessionId: string): TaskState;
}

export interface RuntimeTaskSurfaceMethods {
  setSpec(sessionId: string, spec: TaskSpec): void;
  addItem(
    sessionId: string,
    input: { text: string; status?: TaskItemStatus; id?: string },
  ): TaskItemAddResult;
  updateItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): TaskItemUpdateResult;
  recordBlocker(
    sessionId: string,
    input: {
      id?: string;
      message: string;
      source?: string;
      truthFactId?: string;
    },
  ): TaskBlockerRecordResult;
  recordAcceptance(
    sessionId: string,
    input: {
      status: "pending" | "accepted" | "rejected";
      decidedBy?: string;
      notes?: string;
    },
  ): TaskAcceptanceRecordResult;
  resolveBlocker(sessionId: string, blockerId: string): TaskBlockerResolveResult;
  getTargetDescriptor(sessionId: string): TaskTargetDescriptor;
  getState(sessionId: string): TaskState;
}

export const taskSurfaceContribution = {
  authority: [
    "setSpec",
    "addItem",
    "updateItem",
    "recordBlocker",
    "recordAcceptance",
    "resolveBlocker",
  ],
  inspect: ["getTargetDescriptor", "getState"],
} as const satisfies SurfaceContribution<RuntimeTaskSurfaceMethods>;

export function createTaskSurfaceMethods(deps: TaskSurfaceDependencies): RuntimeTaskSurfaceMethods {
  return {
    setSpec: (sessionId: string, spec: TaskSpec) =>
      deps.getTaskService().setTaskSpec(sessionId, spec),
    addItem: (sessionId: string, input) => deps.getTaskService().addTaskItem(sessionId, input),
    updateItem: (sessionId: string, input) =>
      deps.getTaskService().updateTaskItem(sessionId, input),
    recordBlocker: (sessionId: string, input) =>
      deps.getTaskService().recordTaskBlocker(sessionId, input),
    recordAcceptance: (sessionId: string, input) =>
      deps.getTaskService().recordTaskAcceptance(sessionId, input),
    resolveBlocker: (sessionId: string, blockerId: string) =>
      deps.getTaskService().resolveTaskBlocker(sessionId, blockerId),
    getTargetDescriptor: (sessionId: string) => deps.getTaskTargetDescriptor(sessionId),
    getState: (sessionId: string) => deps.getTaskState(sessionId),
  };
}

export const taskRuntimeSurface = defineRuntimeSurfaceModule({
  name: "task",
  createMethods: createTaskSurfaceMethods,
  contribution: taskSurfaceContribution,
});
