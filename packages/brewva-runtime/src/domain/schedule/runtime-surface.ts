import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { ScheduleIntentService } from "./schedule-intent.js";

export interface ScheduleSurfaceDependencies {
  getScheduleIntentService(): ScheduleIntentService;
}

export function createScheduleSurfaceMethods(deps: ScheduleSurfaceDependencies) {
  return {
    createIntent: (
      sessionId: string,
      input: Parameters<ScheduleIntentService["createScheduleIntent"]>[1],
    ) => deps.getScheduleIntentService().createScheduleIntent(sessionId, input),
    cancelIntent: (
      sessionId: string,
      input: Parameters<ScheduleIntentService["cancelScheduleIntent"]>[1],
    ) => deps.getScheduleIntentService().cancelScheduleIntent(sessionId, input),
    updateIntent: (
      sessionId: string,
      input: Parameters<ScheduleIntentService["updateScheduleIntent"]>[1],
    ) => deps.getScheduleIntentService().updateScheduleIntent(sessionId, input),
    listIntents: (query?: Parameters<ScheduleIntentService["listScheduleIntents"]>[0]) =>
      deps.getScheduleIntentService().listScheduleIntents(query),
    getProjectionSnapshot: () => deps.getScheduleIntentService().getScheduleProjectionSnapshot(),
  };
}

export type RuntimeScheduleSurfaceMethods = ReturnType<typeof createScheduleSurfaceMethods>;

export const scheduleSurfaceContribution = {
  authority: ["createIntent", "cancelIntent", "updateIntent"],
  inspect: ["listIntents", "getProjectionSnapshot"],
} as const satisfies SurfaceContribution<RuntimeScheduleSurfaceMethods>;

export const scheduleRuntimeSurface = defineRuntimeSurfaceModule({
  name: "schedule",
  createMethods: createScheduleSurfaceMethods,
  contribution: scheduleSurfaceContribution,
});
