import type { BrewvaEventQuery, BrewvaEventRecord } from "../contracts/index.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
} from "../events/event-types.js";
import type { JsonValue } from "../utils/json.js";

export const ITERATION_FACTS_SCHEMA = "brewva.iteration-facts.v1" as const;

export const ITERATION_METRIC_AGGREGATION_VALUES = [
  "last",
  "min",
  "max",
  "avg",
  "median",
  "p50",
  "p95",
  "p99",
] as const;
export type IterationMetricAggregation = (typeof ITERATION_METRIC_AGGREGATION_VALUES)[number];

export const ITERATION_GUARD_STATUS_VALUES = ["pass", "fail", "inconclusive", "skipped"] as const;
export type IterationGuardStatus = (typeof ITERATION_GUARD_STATUS_VALUES)[number];

export const ITERATION_FACT_SESSION_SCOPE_VALUES = ["current_session"] as const;
export type IterationFactSessionScope = (typeof ITERATION_FACT_SESSION_SCOPE_VALUES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return value;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function readJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  return isRecord(value) ? (value as Record<string, JsonValue>) : undefined;
}

function isIterationMetricAggregation(value: unknown): value is IterationMetricAggregation {
  return (
    typeof value === "string" &&
    (ITERATION_METRIC_AGGREGATION_VALUES as readonly string[]).includes(value)
  );
}

function isIterationGuardStatus(value: unknown): value is IterationGuardStatus {
  return (
    typeof value === "string" &&
    (ITERATION_GUARD_STATUS_VALUES as readonly string[]).includes(value)
  );
}

export interface MetricObservationInput {
  metricKey: string;
  value: number;
  source: string;
  iterationKey?: string;
  unit?: string;
  aggregation?: IterationMetricAggregation;
  sampleCount?: number;
  evidenceRefs?: string[];
  summary?: string;
  details?: Record<string, JsonValue>;
  turn?: number;
  timestamp?: number;
}

export interface MetricObservationPayload {
  schema: typeof ITERATION_FACTS_SCHEMA;
  kind: "metric_observation";
  metricKey: string;
  value: number;
  source: string;
  iterationKey?: string;
  unit?: string;
  aggregation?: IterationMetricAggregation;
  sampleCount?: number;
  evidenceRefs: string[];
  summary?: string;
  details?: Record<string, JsonValue>;
}

export interface MetricObservationRecord extends MetricObservationPayload {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
}

export interface GuardResultInput {
  guardKey: string;
  status: IterationGuardStatus;
  source: string;
  iterationKey?: string;
  evidenceRefs?: string[];
  summary?: string;
  details?: Record<string, JsonValue>;
  turn?: number;
  timestamp?: number;
}

export interface GuardResultPayload {
  schema: typeof ITERATION_FACTS_SCHEMA;
  kind: "guard_result";
  guardKey: string;
  status: IterationGuardStatus;
  source: string;
  iterationKey?: string;
  evidenceRefs: string[];
  summary?: string;
  details?: Record<string, JsonValue>;
}

export interface GuardResultRecord extends GuardResultPayload {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
}
export type IterationFactRecord = MetricObservationRecord | GuardResultRecord;

interface IterationFactQueryBase extends BrewvaEventQuery {
  source?: string;
  sessionScope?: IterationFactSessionScope;
}

export interface MetricObservationQuery extends IterationFactQueryBase {
  metricKey?: string;
  iterationKey?: string;
}

export interface GuardResultQuery extends IterationFactQueryBase {
  guardKey?: string;
  iterationKey?: string;
  status?: IterationGuardStatus;
}

export function buildMetricObservationPayload(
  input: MetricObservationInput,
): MetricObservationPayload {
  return {
    schema: ITERATION_FACTS_SCHEMA,
    kind: "metric_observation",
    metricKey: input.metricKey.trim(),
    value: input.value,
    source: input.source.trim(),
    iterationKey: readString(input.iterationKey),
    unit: readString(input.unit),
    aggregation: input.aggregation,
    sampleCount: readOptionalPositiveInteger(input.sampleCount),
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    summary: readString(input.summary),
    details: input.details,
  };
}

export function buildGuardResultPayload(input: GuardResultInput): GuardResultPayload {
  return {
    schema: ITERATION_FACTS_SCHEMA,
    kind: "guard_result",
    guardKey: input.guardKey.trim(),
    status: input.status,
    source: input.source.trim(),
    iterationKey: readString(input.iterationKey),
    evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
    summary: readString(input.summary),
    details: input.details,
  };
}

export function coerceMetricObservationPayload(
  payload: unknown,
): MetricObservationPayload | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.schema !== ITERATION_FACTS_SCHEMA || payload.kind !== "metric_observation") {
    return undefined;
  }
  const metricKey = readString(payload.metricKey);
  const source = readString(payload.source);
  const value = readNumber(payload.value);
  if (!metricKey || !source || value === undefined) {
    return undefined;
  }
  const aggregation = isIterationMetricAggregation(payload.aggregation)
    ? payload.aggregation
    : undefined;
  return {
    schema: ITERATION_FACTS_SCHEMA,
    kind: "metric_observation",
    metricKey,
    value,
    source,
    iterationKey: readString(payload.iterationKey),
    unit: readString(payload.unit),
    aggregation,
    sampleCount: readOptionalPositiveInteger(payload.sampleCount),
    evidenceRefs: uniqueStrings(readStringArray(payload.evidenceRefs)),
    summary: readString(payload.summary),
    details: readJsonRecord(payload.details),
  };
}

export function coerceGuardResultPayload(payload: unknown): GuardResultPayload | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.schema !== ITERATION_FACTS_SCHEMA || payload.kind !== "guard_result") {
    return undefined;
  }
  const guardKey = readString(payload.guardKey);
  const source = readString(payload.source);
  if (!guardKey || !source || !isIterationGuardStatus(payload.status)) {
    return undefined;
  }
  return {
    schema: ITERATION_FACTS_SCHEMA,
    kind: "guard_result",
    guardKey,
    status: payload.status,
    source,
    iterationKey: readString(payload.iterationKey),
    evidenceRefs: uniqueStrings(readStringArray(payload.evidenceRefs)),
    summary: readString(payload.summary),
    details: readJsonRecord(payload.details),
  };
}

export function toMetricObservationRecord(
  event: BrewvaEventRecord,
): MetricObservationRecord | undefined {
  const payload = coerceMetricObservationPayload(event.payload);
  if (!payload) return undefined;
  return {
    eventId: event.id,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    turn: event.turn,
    ...payload,
  };
}

export function toGuardResultRecord(event: BrewvaEventRecord): GuardResultRecord | undefined {
  const payload = coerceGuardResultPayload(event.payload);
  if (!payload) return undefined;
  return {
    eventId: event.id,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    turn: event.turn,
    ...payload,
  };
}

export function getMetricObservationEventQuery(
  query: MetricObservationQuery = {},
): BrewvaEventQuery {
  return {
    type: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
    after: query.after,
    before: query.before,
  };
}

export function getGuardResultEventQuery(query: GuardResultQuery = {}): BrewvaEventQuery {
  return {
    type: ITERATION_GUARD_RECORDED_EVENT_TYPE,
    after: query.after,
    before: query.before,
  };
}

export function applyFactWindow<T>(
  records: readonly T[],
  query: Pick<BrewvaEventQuery, "last" | "offset" | "limit"> = {},
): T[] {
  let next = [...records];
  const last = typeof query.last === "number" && query.last > 0 ? Math.floor(query.last) : null;
  const offset =
    typeof query.offset === "number" && query.offset > 0 ? Math.floor(query.offset) : null;
  const limit =
    typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : null;

  if (last !== null) {
    next = next.slice(-last);
  }
  if (offset !== null && offset > 0) {
    next = next.slice(offset);
  }
  if (limit !== null) {
    next = next.slice(0, limit);
  }
  return next;
}

export function filterMetricObservationRecords(
  records: readonly MetricObservationRecord[],
  query: MetricObservationQuery = {},
): MetricObservationRecord[] {
  return records.filter((record) => {
    if (query.metricKey && record.metricKey !== query.metricKey) return false;
    if (query.iterationKey && record.iterationKey !== query.iterationKey) return false;
    if (query.source && record.source !== query.source) return false;
    return true;
  });
}

export function filterGuardResultRecords(
  records: readonly GuardResultRecord[],
  query: GuardResultQuery = {},
): GuardResultRecord[] {
  return records.filter((record) => {
    if (query.guardKey && record.guardKey !== query.guardKey) return false;
    if (query.iterationKey && record.iterationKey !== query.iterationKey) return false;
    if (query.status && record.status !== query.status) return false;
    if (query.source && record.source !== query.source) return false;
    return true;
  });
}
