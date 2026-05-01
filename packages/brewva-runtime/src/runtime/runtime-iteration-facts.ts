import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  applyFactWindow,
  buildGuardResultPayload,
  buildMetricObservationPayload,
  coerceGuardResultPayload,
  coerceMetricObservationPayload,
  filterGuardResultRecords,
  filterMetricObservationRecords,
  getGuardResultEventQuery,
  getMetricObservationEventQuery,
  toGuardResultRecord,
  toMetricObservationRecord,
  type GuardResultInput,
  type GuardResultQuery,
  type GuardResultRecord,
  type IterationFactSessionScope,
  type MetricObservationInput,
  type MetricObservationQuery,
  type MetricObservationRecord,
} from "../domain/iteration/api.js";
import type { RuntimeRecordEvent } from "../domain/sessions/api.js";
import type { BrewvaEventQuery, BrewvaEventRecord } from "../events/types.js";

export interface RuntimeIterationFactControllerOptions {
  eventStore: {
    list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
  };
  recordEvent: RuntimeRecordEvent;
}

export class RuntimeIterationFactController {
  private readonly eventStore: RuntimeIterationFactControllerOptions["eventStore"];
  private readonly recordEvent: RuntimeRecordEvent;

  constructor(options: RuntimeIterationFactControllerOptions) {
    this.eventStore = options.eventStore;
    this.recordEvent = options.recordEvent;
  }

  recordMetricObservation(
    sessionId: string,
    input: MetricObservationInput,
  ): BrewvaEventRecord | undefined {
    const payload = coerceMetricObservationPayload(buildMetricObservationPayload(input));
    if (!payload) return undefined;
    return this.recordEvent({
      sessionId,
      type: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
      turn: input.turn,
      timestamp: input.timestamp,
      payload,
    });
  }

  listMetricObservations(
    sessionId: string,
    query: MetricObservationQuery = {},
  ): MetricObservationRecord[] {
    const records = this.listIterationFactRecords(
      sessionId,
      query,
      getMetricObservationEventQuery,
      toMetricObservationRecord,
    );
    return applyFactWindow(filterMetricObservationRecords(records, query), query);
  }

  recordGuardResult(sessionId: string, input: GuardResultInput): BrewvaEventRecord | undefined {
    const payload = coerceGuardResultPayload(buildGuardResultPayload(input));
    if (!payload) return undefined;
    return this.recordEvent({
      sessionId,
      type: ITERATION_GUARD_RECORDED_EVENT_TYPE,
      turn: input.turn,
      timestamp: input.timestamp,
      payload,
    });
  }

  listGuardResults(sessionId: string, query: GuardResultQuery = {}): GuardResultRecord[] {
    const records = this.listIterationFactRecords(
      sessionId,
      query,
      getGuardResultEventQuery,
      toGuardResultRecord,
    );
    return applyFactWindow(filterGuardResultRecords(records, query), query);
  }

  private listIterationFactRecords<
    TRecord extends { eventId: string; timestamp: number },
    TQuery extends { sessionScope?: IterationFactSessionScope },
  >(
    sessionId: string,
    query: TQuery,
    buildEventQuery: (query: TQuery) => BrewvaEventQuery,
    toRecord: (event: BrewvaEventRecord) => TRecord | undefined,
  ): TRecord[] {
    const records: TRecord[] = [];
    for (const event of this.eventStore.list(sessionId, buildEventQuery(query))) {
      const record = toRecord(event);
      if (record) {
        records.push(record);
      }
    }
    return records.toSorted(
      (left, right) =>
        left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId),
    );
  }
}
