import type {
  ScheduleIntentCancelInput,
  ScheduleIntentCreateInput,
  ScheduleIntentListQuery,
  ScheduleIntentUpdateInput,
} from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function createScheduleIntent(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: ScheduleIntentCreateInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["schedule"]["intents"]["create"]> {
  return runtime.capabilities.schedule.intents.create(sessionId, input);
}

export function updateScheduleIntent(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: ScheduleIntentUpdateInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["schedule"]["intents"]["update"]> {
  return runtime.capabilities.schedule.intents.update(sessionId, input);
}

export function cancelScheduleIntent(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: ScheduleIntentCancelInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["schedule"]["intents"]["cancel"]> {
  return runtime.capabilities.schedule.intents.cancel(sessionId, input);
}

export function listScheduleIntents(
  runtime: BrewvaToolRuntime,
  query: ScheduleIntentListQuery,
): ReturnType<BrewvaToolRuntime["capabilities"]["schedule"]["intents"]["list"]> {
  return runtime.capabilities.schedule.intents.list(query);
}

export function getScheduleProjectionSnapshot(
  runtime: BrewvaToolRuntime,
): ReturnType<BrewvaToolRuntime["capabilities"]["schedule"]["intents"]["getProjectionSnapshot"]> {
  return runtime.capabilities.schedule.intents.getProjectionSnapshot();
}
