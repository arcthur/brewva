import type { BrewvaEventStore } from "../../events/store.js";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
} from "../../events/types.js";
import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type {
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
} from "../iteration/api.js";
import type { RuntimeRecordEvent } from "../sessions/api.js";

export interface EventsSurfaceDependencies {
  recordEvent: RuntimeRecordEvent;
  eventStore: BrewvaEventStore;
  eventPipeline: {
    queryEvents(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    queryStructuredEvents(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
    listReplaySessions(limit?: number): BrewvaReplaySession[];
    subscribeEvents(listener: (event: BrewvaStructuredEvent) => void): () => void;
    toStructuredEvent(event: BrewvaEventRecord): BrewvaStructuredEvent;
  };
  recordMetricObservation(
    sessionId: string,
    input: MetricObservationInput,
  ): BrewvaEventRecord | undefined;
  listMetricObservations(
    sessionId: string,
    query?: MetricObservationQuery,
  ): MetricObservationRecord[];
  recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
  listGuardResults(sessionId: string, query?: GuardResultQuery): GuardResultRecord[];
}

export interface RuntimeEventsSurfaceMethods {
  record: RuntimeRecordEvent;
  resolveLogPath(sessionId: string): string;
  getLogPath(sessionId: string): string;
  query(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  queryStructured(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
  recordMetricObservation(
    sessionId: string,
    input: MetricObservationInput,
  ): BrewvaEventRecord | undefined;
  listMetricObservations(
    sessionId: string,
    query?: MetricObservationQuery,
  ): MetricObservationRecord[];
  recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
  listGuardResults(sessionId: string, query?: GuardResultQuery): GuardResultRecord[];
  listReplaySessions(limit?: number): BrewvaReplaySession[];
  subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
  toStructured(event: BrewvaEventRecord): BrewvaStructuredEvent;
  list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  listSessionIds(): string[];
}

export const eventsSurfaceContribution = {
  authority: ["recordMetricObservation", "recordGuardResult"],
  inspect: [
    "query",
    "queryStructured",
    "listMetricObservations",
    "listGuardResults",
    "getLogPath",
    "listReplaySessions",
    "subscribe",
    "toStructured",
    "list",
    "listSessionIds",
  ],
} as const satisfies SurfaceContribution<RuntimeEventsSurfaceMethods>;

export function createEventsSurfaceMethods(
  deps: EventsSurfaceDependencies,
): RuntimeEventsSurfaceMethods {
  return {
    record: (input) => deps.recordEvent(input),
    resolveLogPath: (sessionId: string) => deps.eventStore.getLogPath(sessionId),
    getLogPath: (sessionId: string) => deps.eventStore.getLogPath(sessionId),
    query: (sessionId: string, query?: BrewvaEventQuery) =>
      deps.eventPipeline.queryEvents(sessionId, query),
    queryStructured: (sessionId: string, query?: BrewvaEventQuery) =>
      deps.eventPipeline.queryStructuredEvents(sessionId, query),
    recordMetricObservation: (sessionId: string, input: MetricObservationInput) =>
      deps.recordMetricObservation(sessionId, input),
    listMetricObservations: (sessionId: string, query?: MetricObservationQuery) =>
      deps.listMetricObservations(sessionId, query),
    recordGuardResult: (sessionId: string, input: GuardResultInput) =>
      deps.recordGuardResult(sessionId, input),
    listGuardResults: (sessionId: string, query?: GuardResultQuery) =>
      deps.listGuardResults(sessionId, query),
    listReplaySessions: (limit?: number) => deps.eventPipeline.listReplaySessions(limit),
    subscribe: (listener: (event: BrewvaStructuredEvent) => void) =>
      deps.eventPipeline.subscribeEvents(listener),
    toStructured: (event: BrewvaEventRecord) => deps.eventPipeline.toStructuredEvent(event),
    list: (sessionId: string, query?: BrewvaEventQuery) => deps.eventStore.list(sessionId, query),
    listSessionIds: () => deps.eventStore.listSessionIds(),
  };
}

export const eventsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "events",
  createMethods: createEventsSurfaceMethods,
  contribution: eventsSurfaceContribution,
});
