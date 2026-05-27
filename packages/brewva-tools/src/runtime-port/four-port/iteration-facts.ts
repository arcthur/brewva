import type { BrewvaEventRecord, ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type {
  GuardResultQuery,
  GuardResultRecord,
  MetricObservationQuery,
  MetricObservationRecord,
} from "@brewva/brewva-vocabulary/iteration";
import { normalizeWindowCount, readRecord, sliceWindow } from "./helpers.js";

function readStringField(record: ProtocolRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metricObservationFromEvent(event: BrewvaEventRecord): MetricObservationRecord | null {
  if (event.type !== "iteration.metric.observed") {
    return null;
  }
  const payload = readRecord(event.payload);
  const metricKey = readStringField(payload, "metricKey");
  const source = readStringField(payload, "source");
  const value = payload.value;
  if (!metricKey || !source || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return {
    ...payload,
    eventId: event.id,
    metricKey,
    value,
    source,
    unit: readStringField(payload, "unit"),
    aggregation: readStringField(payload, "aggregation"),
    iterationKey: readStringField(payload, "iterationKey"),
  };
}

function guardResultFromEvent(event: BrewvaEventRecord): GuardResultRecord | null {
  if (event.type !== "iteration.guard.recorded") {
    return null;
  }
  const payload = readRecord(event.payload);
  const guardKey = readStringField(payload, "guardKey");
  const status = readStringField(payload, "status");
  const source = readStringField(payload, "source");
  if (!guardKey || !status || !source) {
    return null;
  }
  return {
    ...payload,
    eventId: event.id,
    guardKey,
    status,
    source,
    iterationKey: readStringField(payload, "iterationKey"),
  };
}

function matchesStringQuery(record: ProtocolRecord, query: ProtocolRecord, key: string): boolean {
  const expected = readStringField(query, key);
  return expected === undefined || record[key] === expected;
}

function filterIterationRecords<TRecord extends ProtocolRecord>(
  records: readonly TRecord[],
  query: ProtocolRecord | undefined,
  keys: readonly string[],
): TRecord[] {
  const filtered = query
    ? records.filter((record) => keys.every((key) => matchesStringQuery(record, query, key)))
    : [...records];
  const last = normalizeWindowCount(query?.last);
  const offset = normalizeWindowCount(query?.offset);
  const limit = normalizeWindowCount(query?.limit);
  const window = last === null ? filtered : filtered.slice(Math.max(0, filtered.length - last));
  return sliceWindow(window, offset, limit);
}

export function listMetricObservationsFromEvents(
  events: readonly BrewvaEventRecord[],
  query?: MetricObservationQuery,
): MetricObservationRecord[] {
  return filterIterationRecords(
    events
      .map(metricObservationFromEvent)
      .filter((record): record is MetricObservationRecord => Boolean(record)),
    query,
    ["metricKey", "iterationKey", "source", "sessionScope"],
  );
}

export function listGuardResultsFromEvents(
  events: readonly BrewvaEventRecord[],
  query?: GuardResultQuery,
): GuardResultRecord[] {
  return filterIterationRecords(
    events
      .map(guardResultFromEvent)
      .filter((record): record is GuardResultRecord => Boolean(record)),
    query,
    ["guardKey", "status", "iterationKey", "source", "sessionScope"],
  );
}
