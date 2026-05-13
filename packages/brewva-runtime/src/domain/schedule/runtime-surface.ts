import type { ScheduleIntentService } from "./schedule-intent.js";

export interface ScheduleSurfaceDependencies {
  getScheduleIntentService(): ScheduleIntentService;
}

export function createScheduleSurfaceMethods(deps: ScheduleSurfaceDependencies) {
  return {
    authority: {
      intents: {
        create: (
          sessionId: string,
          input: Parameters<ScheduleIntentService["createScheduleIntent"]>[1],
        ) => deps.getScheduleIntentService().createScheduleIntent(sessionId, input),
        cancel: (
          sessionId: string,
          input: Parameters<ScheduleIntentService["cancelScheduleIntent"]>[1],
        ) => deps.getScheduleIntentService().cancelScheduleIntent(sessionId, input),
        update: (
          sessionId: string,
          input: Parameters<ScheduleIntentService["updateScheduleIntent"]>[1],
        ) => deps.getScheduleIntentService().updateScheduleIntent(sessionId, input),
      },
    },
    inspect: {
      intents: {
        list: (query?: Parameters<ScheduleIntentService["listScheduleIntents"]>[0]) =>
          deps.getScheduleIntentService().listScheduleIntents(query),
        getProjectionSnapshot: () =>
          deps.getScheduleIntentService().getScheduleProjectionSnapshot(),
      },
    },
  };
}

export type RuntimeScheduleSurfaceMethods = ReturnType<typeof createScheduleSurfaceMethods>;

export function createScheduleAuthoritySurface(deps: ScheduleSurfaceDependencies) {
  return createScheduleSurfaceMethods(deps).authority;
}

export function createScheduleInspectSurface(deps: ScheduleSurfaceDependencies) {
  return createScheduleSurfaceMethods(deps).inspect;
}
