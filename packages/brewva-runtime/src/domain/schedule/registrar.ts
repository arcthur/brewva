import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { scheduleSurfaceContribution } from "./runtime-surface.js";
import { ScheduleIntentService } from "./schedule-intent.js";
import { SchedulerService } from "./service.js";

export interface RuntimeScheduleDomainRegistration {
  lazyFactories: {
    createScheduleIntentService(): ScheduleIntentService;
  };
  surfaceContribution: typeof scheduleSurfaceContribution;
}

export function registerScheduleDomain(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeScheduleDomainRegistration {
  return {
    lazyFactories: {
      createScheduleIntentService: () =>
        new ScheduleIntentService({
          createManager: () =>
            new SchedulerService({
              runtime: {
                workspaceRoot: options.workspaceRoot,
                scheduleConfig: options.config.schedule,
                listSessionIds: () => options.coreDependencies.eventStore.listSessionIds(),
                listEvents: (sessionId, query) =>
                  options.coreDependencies.eventStore.list(sessionId, query),
                recordEvent: (input) => options.eventPipeline.recordEvent(input),
                subscribeEvents: (listener) => options.eventPipeline.subscribeEvents(listener),
                getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
                getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
                recoveryWal: {
                  appendPending: (envelope, source, walOptions) =>
                    options.coreDependencies.recoveryWalStore.appendPending(
                      envelope,
                      source,
                      walOptions,
                    ),
                  markInflight: (walId) =>
                    options.coreDependencies.recoveryWalStore.markInflight(walId),
                  markDone: (walId) => options.coreDependencies.recoveryWalStore.markDone(walId),
                  markFailed: (walId, error) =>
                    options.coreDependencies.recoveryWalStore.markFailed(walId, error),
                  markExpired: (walId) =>
                    options.coreDependencies.recoveryWalStore.markExpired(walId),
                  listPending: () => options.coreDependencies.recoveryWalStore.listPending(),
                },
              },
              enableExecution: false,
            }),
        }),
    },
    surfaceContribution: scheduleSurfaceContribution,
  };
}
