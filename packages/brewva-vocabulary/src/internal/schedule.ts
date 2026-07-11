import { deterministicJitterFraction } from "@brewva/brewva-std/backoff";
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

/**
 * Unforgeable provenance stamp. Only the gateway daemon's reconcile path writes
 * `"config_policy"` (onto the config-authored self-improve intent). Model-facing
 * schedule tools never carry it, so the approval envelope can be authorized from
 * provenance rather than from a mutable, model-reachable (parentSessionId,
 * intentId) name-tuple.
 */
export type ScheduleIntentOrigin = "config_policy";

/**
 * Approval posture for a scheduled worker's effectful tools. "suspend" keeps the
 * interactive approval hop; "auto_within_envelope" lets the config-authored
 * self-improve lane auto-approve within its governed effect boundary. Single
 * source of truth shared by the config type, the daemon, and the edge worker.
 */
export type ScheduleApprovalMode = "suspend" | "auto_within_envelope";

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
  /** Provenance stamp; only the daemon reconcile writes "config_policy". */
  readonly origin?: ScheduleIntentOrigin;
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

/**
 * Compiled 5-field cron matcher. A `null` day-of-month / month / day-of-week means
 * "any" (a wildcard field); minute and hour always carry an explicit value list
 * because the next-run search enumerates them. Each field supports a wildcard, a
 * literal value, or an every-N step — the forms the product actually emits: minute
 * steps (every 5 minutes), hour steps (every 2 hours), day-of-week (Monday), and
 * day-of-month plus month (Jan 1). Ranges and lists are intentionally unsupported.
 */
interface CompiledCronFields {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[] | null;
  readonly months: readonly number[] | null;
  readonly daysOfWeek: readonly number[] | null;
}

type CronFieldResult =
  | { readonly ok: true; readonly values: number[]; readonly wildcard: boolean }
  | { readonly ok: false; readonly reason: string };

function rangeInclusive(min: number, max: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += 1) {
    values.push(value);
  }
  return values;
}

function parseCronField(raw: string, min: number, max: number): CronFieldResult {
  if (raw === "*") {
    return { ok: true, values: rangeInclusive(min, max), wildcard: true };
  }
  const stepMatch = /^\*\/(\d{1,2})$/u.exec(raw);
  if (stepMatch) {
    const step = Number.parseInt(stepMatch[1] ?? "", 10);
    if (!Number.isFinite(step) || step < 1 || step > max) {
      return { ok: false, reason: "cron_range" };
    }
    const values: number[] = [];
    for (let value = min; value <= max; value += step) {
      values.push(value);
    }
    return { ok: true, values, wildcard: false };
  }
  if (/^\d{1,2}$/u.test(raw)) {
    const value = Number.parseInt(raw, 10);
    if (value < min || value > max) {
      return { ok: false, reason: "cron_range" };
    }
    return { ok: true, values: [value], wildcard: false };
  }
  return { ok: false, reason: "unsupported_cron_expression" };
}

function compileCronFields(expression: string): CompiledCronFields | { readonly reason: string } {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    return { reason: "cron_field_count" };
  }
  const minute = parseCronField(fields[0] ?? "", 0, 59);
  if (!minute.ok) return { reason: minute.reason };
  const hour = parseCronField(fields[1] ?? "", 0, 23);
  if (!hour.ok) return { reason: hour.reason };
  const dayOfMonth = parseCronField(fields[2] ?? "", 1, 31);
  if (!dayOfMonth.ok) return { reason: dayOfMonth.reason };
  const month = parseCronField(fields[3] ?? "", 1, 12);
  if (!month.ok) return { reason: month.reason };
  // Day-of-week is 0-6 (0 = Sunday); 7 is also Sunday in cron, normalized to 0.
  const dayOfWeek = parseCronField(fields[4] ?? "", 0, 7);
  if (!dayOfWeek.ok) return { reason: dayOfWeek.reason };
  const normalizedDow = dayOfWeek.wildcard
    ? null
    : [...new Set(dayOfWeek.values.map((value) => (value === 7 ? 0 : value)))].toSorted(
        (left, right) => left - right,
      );
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.wildcard ? null : dayOfMonth.values,
    months: month.wildcard ? null : month.values,
    daysOfWeek: normalizedDow,
  };
}

export function parseCronExpression(expression: string): ParseCronExpressionResult {
  const normalized = expression.trim();
  const compiled = compileCronFields(normalized);
  if ("reason" in compiled) {
    return { ok: false, expression: normalized, reason: compiled.reason };
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

/**
 * Whether a local calendar date satisfies the day-of-month / month / day-of-week
 * fields. Follows Vixie-cron semantics: when BOTH day-of-month and day-of-week are
 * restricted, the date matches if EITHER matches; otherwise both must match. The
 * weekday is taken from the calendar date (timezone-independent for a given Y/M/D).
 */
function cronDateMatches(
  fields: CompiledCronFields,
  date: Pick<LocalMinuteParts, "year" | "month" | "day">,
): boolean {
  if (fields.months !== null && !fields.months.includes(date.month)) {
    return false;
  }
  const { daysOfMonth, daysOfWeek } = fields;
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const domMatch = daysOfMonth === null || daysOfMonth.includes(date.day);
  const dowMatch = daysOfWeek === null || daysOfWeek.includes(weekday);
  if (daysOfMonth !== null && daysOfWeek !== null) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
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
  const compiled = compileCronFields(expression);
  if ("reason" in compiled) {
    return new Date(from.getTime() + 60_000);
  }
  const timeZone = normalizeTimeZone(options.timeZone);
  const formatter = getLocalMinuteFormatter(timeZone);
  const start = from.getTime() + MINUTE_MS - (from.getTime() % MINUTE_MS);
  const startLocal = localTimePartsFor(formatter, new Date(start));

  for (let dayOffset = 0; dayOffset <= 366; dayOffset += 1) {
    const localDate = addCalendarDays(startLocal, dayOffset);
    if (!cronDateMatches(compiled, localDate)) {
      continue;
    }
    for (const hour of compiled.hours) {
      for (const minute of compiled.minutes) {
        const localTarget = { ...localDate, hour, minute };
        for (const instant of localMinuteInstants(formatter, localTarget)) {
          if (instant >= start) {
            return new Date(instant);
          }
        }
      }
    }
  }
  return new Date(start);
}

export interface NextScheduleRunInput {
  readonly runAt?: number;
  readonly cron?: string;
  readonly timeZone?: string;
  readonly intentId?: string;
}

export interface NextScheduleRunOptions {
  /** Compute the next run strictly after this instant (ms epoch). Defaults to now. */
  readonly from?: number;
}

/**
 * Forward jitter is a fraction of the cron interval, capped, so a fast cadence
 * (every minute) gets near-zero spread while a daily cadence is spread over
 * minutes — avoiding a thundering herd of intents firing on the same boundary.
 */
const RECURRING_JITTER_INTERVAL_RATIO = 0.1;
const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000;

/**
 * Compute an intent's next `nextRunAt` (ms epoch), or null when it has no future
 * run. A one-shot `runAt` is returned verbatim. A `cron` intent is advanced to its
 * next timezone-correct slot via `getNextCronRunAt`, plus a deterministic forward
 * jitter that is a capped fraction of the cron interval and stable per intent (so
 * the event-carried `nextRunAt` stays authoritative under replay). An unparseable
 * or absent cron yields null so the caller declines to arm rather than silently
 * firing at a wrong time.
 *
 * This is the single source of truth for cron recurrence: the schedule projection
 * and the daemon timer driver both call it. They prefer a persisted `nextRunAt` and
 * extract the spec the same way (`mergeScheduleSpec`), so they agree on every intent
 * the system writes; only a legacy event lacking a persisted value derives
 * independently, differing at most by the display-vs-arming clock reference.
 */
export function nextScheduleRunAt(
  input: NextScheduleRunInput,
  options: NextScheduleRunOptions = {},
): number | null {
  if (typeof input.runAt === "number" && Number.isFinite(input.runAt)) {
    return Math.trunc(input.runAt);
  }
  if (typeof input.cron !== "string" || input.cron.trim().length === 0) {
    return null;
  }
  const parsed = parseCronExpression(input.cron);
  if (!parsed.ok) {
    return null;
  }
  const from =
    typeof options.from === "number" && Number.isFinite(options.from) ? options.from : Date.now();
  const exact = getNextCronRunAt(parsed.expression, {
    from: new Date(from),
    timeZone: input.timeZone,
  }).getTime();
  const following = getNextCronRunAt(parsed.expression, {
    from: new Date(exact),
    timeZone: input.timeZone,
  }).getTime();
  if (!Number.isFinite(following) || following <= exact) {
    return exact;
  }
  const intervalMs = following - exact;
  const jitterMs = Math.floor(
    Math.min(
      MAX_RECURRING_JITTER_MS,
      intervalMs *
        RECURRING_JITTER_INTERVAL_RATIO *
        deterministicJitterFraction(input.intentId ?? parsed.expression),
    ),
  );
  return exact + jitterMs;
}

/**
 * Build a `NextScheduleRunInput` from the MERGED spec of an event payload and the
 * intent's prior state — the event overrides prior fields, so a partial update that
 * omits `cron` / `runAt` / `timeZone` re-derives the next run from the retained spec
 * rather than dropping it. Shared by the schedule projection and the daemon timer
 * driver so both read models extract the spec identically.
 */
export function mergeScheduleSpec(
  input: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  intentId: string,
): NextScheduleRunInput {
  const mergedNumber = (key: string): number | undefined => {
    const value = input[key];
    if (typeof value === "number") {
      return value;
    }
    const prior = previous?.[key];
    return typeof prior === "number" ? prior : undefined;
  };
  const mergedString = (key: string): string | undefined => {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
    const prior = previous?.[key];
    return typeof prior === "string" ? prior : undefined;
  };
  return {
    runAt: mergedNumber("runAt"),
    cron: mergedString("cron"),
    timeZone: mergedString("timeZone"),
    intentId,
  };
}
