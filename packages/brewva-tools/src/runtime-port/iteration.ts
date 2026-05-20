import type {
  GuardResultInput,
  GuardResultQuery,
  MetricObservationInput,
  MetricObservationQuery,
} from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function recordMetricObservation(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: MetricObservationInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["events"]["recordMetricObservation"]> {
  return runtime.capabilities.events.recordMetricObservation(sessionId, input);
}

export function recordGuardResult(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  input: GuardResultInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["events"]["recordGuardResult"]> {
  return runtime.capabilities.events.recordGuardResult(sessionId, input);
}

export function listMetricObservations(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  query?: MetricObservationQuery,
): ReturnType<BrewvaToolRuntime["capabilities"]["events"]["iteration"]["listMetricObservations"]> {
  return runtime.capabilities.events.iteration.listMetricObservations(sessionId, query);
}

export function listGuardResults(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  query?: GuardResultQuery,
): ReturnType<BrewvaToolRuntime["capabilities"]["events"]["iteration"]["listGuardResults"]> {
  return runtime.capabilities.events.iteration.listGuardResults(sessionId, query);
}
