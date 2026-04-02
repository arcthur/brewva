import type { BrewvaEventRecord, ScheduleIntentEventPayload } from "../contracts/index.js";

export const SCHEDULE_EVENT_TYPE = "schedule_intent";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConvergencePredicate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "truth_resolved":
      return typeof value.factId === "string" && value.factId.trim().length > 0;
    case "task_phase":
      return typeof value.phase === "string" && value.phase.trim().length > 0;
    case "max_runs":
      return typeof value.limit === "number" && Number.isFinite(value.limit) && value.limit > 0;
    case "all_of":
    case "any_of":
      return (
        Array.isArray(value.predicates) &&
        value.predicates.length > 0 &&
        value.predicates.every((entry) => isConvergencePredicate(entry))
      );
    default:
      return false;
  }
}

export function isScheduleIntentEventPayload(value: unknown): value is ScheduleIntentEventPayload {
  if (!isRecord(value)) return false;
  if (value.schema !== "brewva.schedule.v1") return false;
  if (typeof value.kind !== "string") return false;
  if (typeof value.intentId !== "string" || value.intentId.trim().length === 0) return false;
  if (typeof value.reason !== "string" || value.reason.trim().length === 0) return false;
  if (typeof value.parentSessionId !== "string" || value.parentSessionId.trim().length === 0)
    return false;
  if (value.continuityMode !== "inherit" && value.continuityMode !== "fresh") return false;
  if (typeof value.maxRuns !== "number" || !Number.isFinite(value.maxRuns) || value.maxRuns <= 0) {
    return false;
  }
  if (
    value.runAt !== undefined &&
    (typeof value.runAt !== "number" || !Number.isFinite(value.runAt) || value.runAt <= 0)
  ) {
    return false;
  }
  if (
    value.runIndex !== undefined &&
    (typeof value.runIndex !== "number" || !Number.isFinite(value.runIndex) || value.runIndex <= 0)
  ) {
    return false;
  }
  if (
    value.firedAt !== undefined &&
    (typeof value.firedAt !== "number" || !Number.isFinite(value.firedAt) || value.firedAt <= 0)
  ) {
    return false;
  }
  if (
    value.nextRunAt !== undefined &&
    (typeof value.nextRunAt !== "number" ||
      !Number.isFinite(value.nextRunAt) ||
      value.nextRunAt <= 0)
  ) {
    return false;
  }
  if (value.goalRef !== undefined && typeof value.goalRef !== "string") return false;
  if (value.cron !== undefined && typeof value.cron !== "string") return false;
  if (
    value.timeZone !== undefined &&
    (typeof value.timeZone !== "string" || value.timeZone.trim().length === 0)
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (value.childSessionId !== undefined && typeof value.childSessionId !== "string") return false;
  if (
    value.convergenceCondition !== undefined &&
    !isConvergencePredicate(value.convergenceCondition)
  ) {
    return false;
  }

  switch (value.kind) {
    case "intent_created": {
      const hasRunAt = value.runAt !== undefined;
      const hasCron = value.cron !== undefined;
      if (hasRunAt === hasCron) return false;
      if (value.timeZone !== undefined && !hasCron) return false;
      return value.nextRunAt !== undefined;
    }
    case "intent_updated":
    case "intent_cancelled":
    case "intent_converged":
      return true;
    case "intent_fired":
      return value.runIndex !== undefined && value.firedAt !== undefined;
    default:
      return false;
  }
}

export function parseScheduleIntentEvent(
  row: BrewvaEventRecord,
): ScheduleIntentEventPayload | null {
  if (row.type !== SCHEDULE_EVENT_TYPE) return null;
  if (!isScheduleIntentEventPayload(row.payload)) return null;
  return row.payload;
}

export interface BuildScheduleIntentCreatedEventInput {
  intentId: string;
  parentSessionId: string;
  reason: string;
  continuityMode: "inherit" | "fresh";
  maxRuns: number;
  nextRunAt: number;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  goalRef?: string;
  convergenceCondition?: ScheduleIntentEventPayload["convergenceCondition"];
}

export function buildScheduleIntentCreatedEvent(
  input: BuildScheduleIntentCreatedEventInput,
): ScheduleIntentEventPayload {
  return {
    schema: "brewva.schedule.v1",
    kind: "intent_created",
    intentId: input.intentId,
    runAt: input.runAt,
    cron: input.cron,
    timeZone: input.timeZone,
    nextRunAt: input.nextRunAt,
    reason: input.reason,
    goalRef: input.goalRef,
    parentSessionId: input.parentSessionId,
    continuityMode: input.continuityMode,
    maxRuns: input.maxRuns,
    convergenceCondition: input.convergenceCondition,
  };
}

export function buildScheduleIntentUpdatedEvent(input: {
  intentId: string;
  parentSessionId: string;
  reason: string;
  continuityMode: "inherit" | "fresh";
  maxRuns: number;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  nextRunAt?: number;
  goalRef?: string;
  convergenceCondition?: ScheduleIntentEventPayload["convergenceCondition"];
}): ScheduleIntentEventPayload {
  return {
    schema: "brewva.schedule.v1",
    kind: "intent_updated",
    intentId: input.intentId,
    runAt: input.runAt,
    cron: input.cron,
    timeZone: input.timeZone,
    nextRunAt: input.nextRunAt,
    reason: input.reason,
    goalRef: input.goalRef,
    parentSessionId: input.parentSessionId,
    continuityMode: input.continuityMode,
    maxRuns: input.maxRuns,
    convergenceCondition: input.convergenceCondition,
  };
}

export function buildScheduleIntentCancelledEvent(input: {
  intentId: string;
  parentSessionId: string;
  reason: string;
  continuityMode: "inherit" | "fresh";
  maxRuns: number;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  goalRef?: string;
  convergenceCondition?: ScheduleIntentEventPayload["convergenceCondition"];
  error?: string;
}): ScheduleIntentEventPayload {
  return {
    schema: "brewva.schedule.v1",
    kind: "intent_cancelled",
    intentId: input.intentId,
    runAt: input.runAt,
    cron: input.cron,
    timeZone: input.timeZone,
    reason: input.reason,
    goalRef: input.goalRef,
    parentSessionId: input.parentSessionId,
    continuityMode: input.continuityMode,
    maxRuns: input.maxRuns,
    convergenceCondition: input.convergenceCondition,
    error: input.error,
  };
}

export function buildScheduleIntentFiredEvent(input: {
  intentId: string;
  parentSessionId: string;
  reason: string;
  continuityMode: "inherit" | "fresh";
  maxRuns: number;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  goalRef?: string;
  convergenceCondition?: ScheduleIntentEventPayload["convergenceCondition"];
  runIndex: number;
  firedAt: number;
  nextRunAt?: number;
  childSessionId?: string;
  error?: string;
}): ScheduleIntentEventPayload {
  return {
    schema: "brewva.schedule.v1",
    kind: "intent_fired",
    intentId: input.intentId,
    runAt: input.runAt,
    cron: input.cron,
    timeZone: input.timeZone,
    reason: input.reason,
    goalRef: input.goalRef,
    parentSessionId: input.parentSessionId,
    continuityMode: input.continuityMode,
    maxRuns: input.maxRuns,
    convergenceCondition: input.convergenceCondition,
    runIndex: input.runIndex,
    firedAt: input.firedAt,
    nextRunAt: input.nextRunAt,
    childSessionId: input.childSessionId,
    error: input.error,
  };
}

export function buildScheduleIntentConvergedEvent(input: {
  intentId: string;
  parentSessionId: string;
  reason: string;
  continuityMode: "inherit" | "fresh";
  maxRuns: number;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  goalRef?: string;
  convergenceCondition?: ScheduleIntentEventPayload["convergenceCondition"];
}): ScheduleIntentEventPayload {
  return {
    schema: "brewva.schedule.v1",
    kind: "intent_converged",
    intentId: input.intentId,
    runAt: input.runAt,
    cron: input.cron,
    timeZone: input.timeZone,
    reason: input.reason,
    goalRef: input.goalRef,
    parentSessionId: input.parentSessionId,
    continuityMode: input.continuityMode,
    maxRuns: input.maxRuns,
    convergenceCondition: input.convergenceCondition,
  };
}
