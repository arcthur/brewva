import { type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export const SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE = "schedule.child_session.failed" as const;

export const SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE =
  "schedule.child_session.finished" as const;

export const SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE = "schedule.child_session.started" as const;

export const SCHEDULE_EVENT_TYPE = "schedule.intent" as const;

export const SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE = "schedule.recovery.deferred" as const;

export const SCHEDULE_WAKEUP_EVENT_TYPE = "schedule.wakeup" as const;

export type ScheduleContinuityMode = string;

export type ScheduleIntentStatus = string;

export type ScheduleIntentEventKind = string;

export interface ScheduleIntentEventPayload extends ProtocolRecord {
  readonly kind?: ScheduleIntentEventKind;
  readonly intentId?: string;
  readonly error?: string | null;
}

export interface ScheduleIntentProjectionRecord extends ProtocolRecord {
  readonly intentId: string;
  readonly status: ScheduleIntentStatus;
  readonly reason: string;
  readonly parentSessionId: string;
  readonly goalRef?: string;
  readonly continuityMode: ScheduleContinuityMode;
  readonly runAt?: number;
  readonly nextRunAt?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly runCount: number;
  readonly maxRuns: number;
}

export interface ScheduleIntentCreateInput extends ProtocolRecord {
  readonly reason: string;
  readonly intentId?: string;
  readonly goalRef?: string;
  readonly continuityMode?: ScheduleContinuityMode;
  readonly runAt?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly maxRuns?: number;
  readonly convergenceCondition?: unknown;
}

export type ScheduleIntentCreateResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };

export interface ScheduleIntentCancelInput extends ProtocolRecord {
  readonly intentId: string;
  readonly reason?: string;
}

export type ScheduleIntentCancelResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };

export interface ScheduleIntentUpdateInput extends ProtocolRecord {
  readonly intentId: string;
  reason?: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  convergenceCondition?: unknown;
}

export type ScheduleIntentUpdateResult =
  | { readonly ok: true; readonly intent: ScheduleIntentProjectionRecord }
  | { readonly ok: false; readonly reason: string };

export interface ScheduleIntentListQuery extends ProtocolRecord {}

export interface ScheduleProjectionSnapshot extends ProtocolRecord {
  readonly watermarkOffset: number;
}

export interface NextCronRunOptions {
  readonly from?: Date;
  readonly timeZone?: string;
}

export type ParseCronExpressionResult =
  | { readonly ok: true; readonly expression: string }
  | { readonly ok: false; readonly expression: string; readonly reason: string };

export function isScheduleIntentEventPayload(value: unknown): value is ScheduleIntentEventPayload {
  return typeof value === "object" && value !== null;
}

export function parseScheduleIntentEvent(
  record: BrewvaEventRecord,
): ScheduleIntentEventPayload | null {
  return isScheduleIntentEventPayload(record.payload) ? record.payload : null;
}

export function normalizeTimeZone(value: string | undefined): string {
  return value?.trim() || "UTC";
}

export function parseCronExpression(expression: string): ParseCronExpressionResult {
  const normalized = expression.trim();
  const fields = normalized.split(/\s+/u);
  if (fields.length !== 5) {
    return { ok: false, expression: normalized, reason: "cron_field_count" };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    !/^\d{1,2}$/u.test(minute) ||
    !/^\d{1,2}$/u.test(hour) ||
    dayOfMonth !== "*" ||
    month !== "*" ||
    dayOfWeek !== "*"
  ) {
    return { ok: false, expression: normalized, reason: "unsupported_cron_expression" };
  }
  const parsedMinute = Number.parseInt(minute, 10);
  const parsedHour = Number.parseInt(hour, 10);
  if (parsedMinute < 0 || parsedMinute > 59 || parsedHour < 0 || parsedHour > 23) {
    return { ok: false, expression: normalized, reason: "cron_range" };
  }
  return { ok: true, expression: normalized };
}

const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;

interface LocalMinuteParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const localMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getLocalMinuteFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = localMinuteFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  localMinuteFormatterCache.set(timeZone, formatter);
  return formatter;
}

function localTimePartsFor(formatter: Intl.DateTimeFormat, date: Date): LocalMinuteParts {
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year") ?? "0"),
    month: Number(values.get("month") ?? "0"),
    day: Number(values.get("day") ?? "0"),
    hour: Number(values.get("hour") ?? "0"),
    minute: Number(values.get("minute") ?? "0"),
  };
}

function addCalendarDays(
  parts: Pick<LocalMinuteParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalMinuteParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localMinuteMatches(actual: LocalMinuteParts, expected: LocalMinuteParts): boolean {
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute
  );
}

function timeZoneOffsetMs(formatter: Intl.DateTimeFormat, date: Date): number {
  const local = localTimePartsFor(formatter, date);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return localAsUtc - (date.getTime() - (date.getTime() % MINUTE_MS));
}

function localMinuteInstants(formatter: Intl.DateTimeFormat, local: LocalMinuteParts): number[] {
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (const sampleHour of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(timeZoneOffsetMs(formatter, new Date(localAsUtc + sampleHour * HOUR_MS)));
  }

  const seen = new Set<number>();
  const instants: number[] = [];
  for (const offset of offsets) {
    const instant = localAsUtc - offset;
    if (seen.has(instant)) {
      continue;
    }
    if (localMinuteMatches(localTimePartsFor(formatter, new Date(instant)), local)) {
      seen.add(instant);
      instants.push(instant);
    }
  }
  return instants.toSorted((left, right) => left - right);
}

export function getNextCronRunAt(
  expression: string,
  optionsOrAfterMs: NextCronRunOptions | number = {},
  maybeOptions: Omit<NextCronRunOptions, "from"> = {},
): Date {
  const options =
    typeof optionsOrAfterMs === "number"
      ? { ...maybeOptions, from: new Date(optionsOrAfterMs) }
      : optionsOrAfterMs;
  const from = options.from instanceof Date ? options.from : new Date();
  const parsed = parseCronExpression(expression);
  if (!parsed.ok) {
    return new Date(from.getTime() + 60_000);
  }
  const [minuteRaw, hourRaw] = parsed.expression.split(/\s+/u);
  const targetMinute = Number.parseInt(minuteRaw ?? "0", 10);
  const targetHour = Number.parseInt(hourRaw ?? "0", 10);
  const timeZone = normalizeTimeZone(options.timeZone);
  const formatter = getLocalMinuteFormatter(timeZone);
  const start = from.getTime() + MINUTE_MS - (from.getTime() % MINUTE_MS);
  const startLocal = localTimePartsFor(formatter, new Date(start));

  for (let dayOffset = 0; dayOffset <= 366; dayOffset += 1) {
    const localDate = addCalendarDays(startLocal, dayOffset);
    const localTarget = {
      ...localDate,
      hour: targetHour,
      minute: targetMinute,
    };
    for (const instant of localMinuteInstants(formatter, localTarget)) {
      if (instant >= start) {
        return new Date(instant);
      }
    }
  }
  return new Date(start);
}
