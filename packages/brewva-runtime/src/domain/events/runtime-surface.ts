import type { BrewvaEventStore } from "../../events/store.js";
import type {
  BrewvaEventQuery,
  BrewvaEventRecord,
  BrewvaReplaySession,
  BrewvaStructuredEvent,
} from "../../events/types.js";
import {
  deriveTurnEffectCommitmentProjection,
  renderTurnConsequenceDigest,
  type TurnEffectCommitmentProjection,
} from "../projection/api.js";
import type { RuntimeRecordEvent } from "../sessions/api.js";
import type {
  GuardResultInput,
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationInput,
  MetricObservationQuery,
  MetricObservationRecord,
} from "./iteration-facts.js";

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
  records: {
    query(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
    queryStructured(sessionId: string, query?: BrewvaEventQuery): BrewvaStructuredEvent[];
    subscribe(listener: (event: BrewvaStructuredEvent) => void): () => void;
    toStructured(event: BrewvaEventRecord): BrewvaStructuredEvent;
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  };
  log: {
    getPath(sessionId: string): string;
    listReplaySessions(limit?: number): BrewvaReplaySession[];
    listSessionIds(): string[];
  };
  iteration: {
    listMetricObservations(
      sessionId: string,
      query?: MetricObservationQuery,
    ): MetricObservationRecord[];
    listGuardResults(sessionId: string, query?: GuardResultQuery): GuardResultRecord[];
  };
  effects: {
    getTurnProjection(
      sessionId: string,
      input?: { runtimeTurn?: number; turnId?: string },
    ): TurnEffectCommitmentProjection;
    renderTurnDigest(
      sessionId: string,
      input?: { runtimeTurn?: number; turnId?: string; maxChars?: number },
    ): string;
  };
  recordMetricObservation(
    sessionId: string,
    input: MetricObservationInput,
  ): BrewvaEventRecord | undefined;
  recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined;
}

function resolveRuntimeTurn(
  events: readonly BrewvaEventRecord[],
  explicit: number | undefined,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.max(
    0,
    ...events
      .map((event) => event.turn)
      .filter((turn): turn is number => typeof turn === "number" && Number.isFinite(turn)),
  );
}

export function createEventsSurfaceMethods(
  deps: EventsSurfaceDependencies,
): RuntimeEventsSurfaceMethods {
  return {
    records: {
      query: (sessionId: string, query?: BrewvaEventQuery) =>
        deps.eventPipeline.queryEvents(sessionId, query),
      queryStructured: (sessionId: string, query?: BrewvaEventQuery) =>
        deps.eventPipeline.queryStructuredEvents(sessionId, query),
      subscribe: (listener: (event: BrewvaStructuredEvent) => void) =>
        deps.eventPipeline.subscribeEvents(listener),
      toStructured: (event: BrewvaEventRecord) => deps.eventPipeline.toStructuredEvent(event),
      list: (sessionId: string, query?: BrewvaEventQuery) => deps.eventStore.list(sessionId, query),
    },
    log: {
      getPath: (sessionId: string) => deps.eventStore.getLogPath(sessionId),
      listReplaySessions: (limit?: number) => deps.eventPipeline.listReplaySessions(limit),
      listSessionIds: () => deps.eventStore.listSessionIds(),
    },
    iteration: {
      listMetricObservations: (sessionId: string, query?: MetricObservationQuery) =>
        deps.listMetricObservations(sessionId, query),
      listGuardResults: (sessionId: string, query?: GuardResultQuery) =>
        deps.listGuardResults(sessionId, query),
    },
    effects: {
      getTurnProjection: (sessionId: string, input?: { runtimeTurn?: number; turnId?: string }) => {
        const events = deps.eventStore.list(sessionId);
        const runtimeTurn = resolveRuntimeTurn(events, input?.runtimeTurn);
        return deriveTurnEffectCommitmentProjection({
          sessionId,
          turnId: input?.turnId ?? `turn-${runtimeTurn}`,
          runtimeTurn,
          events,
        });
      },
      renderTurnDigest: (
        sessionId: string,
        input?: { runtimeTurn?: number; turnId?: string; maxChars?: number },
      ) => {
        const events = deps.eventStore.list(sessionId);
        const runtimeTurn = resolveRuntimeTurn(events, input?.runtimeTurn);
        const projection = deriveTurnEffectCommitmentProjection({
          sessionId,
          turnId: input?.turnId ?? `turn-${runtimeTurn}`,
          runtimeTurn,
          events,
        });
        return renderTurnConsequenceDigest(projection, { maxChars: input?.maxChars });
      },
    },
    recordMetricObservation: (sessionId: string, input: MetricObservationInput) =>
      deps.recordMetricObservation(sessionId, input),
    recordGuardResult: (sessionId: string, input: GuardResultInput) =>
      deps.recordGuardResult(sessionId, input),
  };
}

export function createEventsAuthoritySurface(deps: EventsSurfaceDependencies) {
  const methods = createEventsSurfaceMethods(deps);
  return {
    recordMetricObservation: (
      sessionId: string,
      input: Parameters<EventsSurfaceDependencies["recordMetricObservation"]>[1],
    ) => methods.recordMetricObservation(sessionId, input),
    recordGuardResult: (
      sessionId: string,
      input: Parameters<EventsSurfaceDependencies["recordGuardResult"]>[1],
    ) => methods.recordGuardResult(sessionId, input),
  };
}

export function createEventsInspectSurface(deps: EventsSurfaceDependencies) {
  const methods = createEventsSurfaceMethods(deps);
  return {
    records: methods.records,
    log: methods.log,
    iteration: methods.iteration,
    effects: methods.effects,
  };
}
