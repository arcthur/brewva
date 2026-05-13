import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import { TASK_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { resolveTaskTargetRoots } from "./targeting.js";
import { TaskWatchdogService } from "./task-watchdog.js";
import { TaskService } from "./task.js";

export interface RuntimeTaskDomainRegistration {
  services: {
    taskService: TaskService;
    taskWatchdogService: TaskWatchdogService;
  };
  eventDescriptors: typeof TASK_EVENT_DESCRIPTORS;
}

export function registerTaskDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeTaskDomainRegistration {
  const taskService = new TaskService({
    config: options.config,
    isContextBudgetEnabled: () => options.kernel.isContextBudgetEnabled(),
    resolveContextBudgetThresholds: (sessionId, usage) => ({
      compactionThresholdPercent:
        options.kernel.contextBudget.getEffectiveCompactionThresholdPercent(sessionId, usage),
      hardLimitPercent: options.kernel.contextBudget.getEffectiveHardLimitPercent(sessionId, usage),
    }),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getClaimState: (sessionId) => options.kernel.getClaimState(sessionId),
    evaluateCompletion: (sessionId) => options.evaluateCompletion(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });
  options.coreDependencies.verificationGate.bindSessionIntrospection({
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot,
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getTargetRoots: (sessionId) =>
      resolveTaskTargetRoots({
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot,
        spec: options.kernel.getTaskState(sessionId).spec,
      }),
  });

  const taskWatchdogService = new TaskWatchdogService({
    listEvents: (sessionId, query) => options.coreDependencies.eventStore.list(sessionId, query),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    recordEvent: (input) => options.kernel.recordEvent(input),
  });

  return {
    services: {
      taskService,
      taskWatchdogService,
    },
    eventDescriptors: TASK_EVENT_DESCRIPTORS,
  };
}
