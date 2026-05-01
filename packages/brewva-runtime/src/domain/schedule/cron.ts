interface CronField {
  readonly min: number;
  readonly max: number;
  readonly values: number[];
  readonly valueSet: ReadonlySet<number>;
  readonly any: boolean;
}

export interface ParsedCronExpression {
  readonly source: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

export interface NextCronRunOptions {
  timeZone?: string;
}

export type ParseCronExpressionResult =
  | { ok: true; expression: ParsedCronExpression }
  | { ok: false; reason: string };

const WEEKDAY_TO_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const timeZoneFormatterCache = new Map<string, Intl.DateTimeFormat>();
const timeZoneNormalizationCache = new Map<string, string>();

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function allValuesInRange(min: number, max: number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value += 1) {
    out.push(value);
  }
  return out;
}

function normalizeDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function parseCronField(input: {
  raw: string;
  min: number;
  max: number;
  normalize?: (value: number) => number;
  anyValues?: number[];
}): CronField | null {
  const raw = input.raw.trim();
  if (raw.length === 0) return null;

  const values = new Set<number>();
  const parts = raw.split(",");

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (part.length === 0) return null;

    const stepSegments = part.split("/");
    if (stepSegments.length > 2) return null;

    const base = stepSegments[0]?.trim() ?? "";
    const step = stepSegments.length === 2 ? parseInteger(stepSegments[1]?.trim() ?? "") : 1;
    if (!step || step <= 0) return null;

    let rangeStart: number;
    let rangeEnd: number;
    if (base === "*") {
      rangeStart = input.min;
      rangeEnd = input.max;
    } else if (base.includes("-")) {
      const rangeSegments = base.split("-");
      if (rangeSegments.length !== 2) return null;
      const [leftRaw, rightRaw] = rangeSegments;
      const left = parseInteger(leftRaw?.trim() ?? "");
      const right = parseInteger(rightRaw?.trim() ?? "");
      if (left === null || right === null) return null;
      if (left > right) return null;
      rangeStart = left;
      rangeEnd = right;
    } else {
      const single = parseInteger(base);
      if (single === null) return null;
      rangeStart = single;
      rangeEnd = single;
    }

    if (rangeStart < input.min || rangeEnd > input.max) return null;

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      const normalized = input.normalize ? input.normalize(value) : value;
      values.add(normalized);
    }
  }

  if (values.size === 0) return null;
  const sorted = [...values.values()].toSorted((left, right) => left - right);
  const valueSet = new Set(sorted);
  const anyValues = input.anyValues ?? allValuesInRange(input.min, input.max);
  const any = anyValues.every((value) => valueSet.has(value));

  return {
    min: input.min,
    max: input.max,
    values: sorted,
    valueSet,
    any,
  };
}

function findNextOnOrAfter(values: number[], current: number): number | undefined {
  for (const value of values) {
    if (value >= current) return value;
  }
  return undefined;
}

function matchesDayParts(
  expression: ParsedCronExpression,
  dayOfMonth: number,
  dayOfWeek: number,
): boolean {
  const domMatch = expression.dayOfMonth.valueSet.has(dayOfMonth);
  const dowMatch = expression.dayOfWeek.valueSet.has(dayOfWeek);

  if (expression.dayOfMonth.any && expression.dayOfWeek.any) return true;
  if (expression.dayOfMonth.any) return dowMatch;
  if (expression.dayOfWeek.any) return domMatch;
  return domMatch || dowMatch;
}

function matchesDay(expression: ParsedCronExpression, date: Date): boolean {
  return matchesDayParts(expression, date.getDate(), date.getDay());
}

function getOrCreateTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = timeZoneFormatterCache.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  timeZoneFormatterCache.set(timeZone, formatter);
  return formatter;
}

function resolveWeekday(value: string): number | undefined {
  const normalized = value.trim().slice(0, 3).toLowerCase();
  return WEEKDAY_TO_INDEX[normalized];
}

function getZonedDateParts(
  formatter: Intl.DateTimeFormat,
  timestampMs: number,
): { month: number; dayOfMonth: number; dayOfWeek: number; hour: number; minute: number } | null {
  const parts = formatter.formatToParts(new Date(timestampMs));
  let month: number | undefined;
  let dayOfMonth: number | undefined;
  let dayOfWeek: number | undefined;
  let hour: number | undefined;
  let minute: number | undefined;

  for (const part of parts) {
    if (part.type === "month") {
      const parsed = parseInteger(part.value);
      if (parsed !== null) month = parsed;
    } else if (part.type === "day") {
      const parsed = parseInteger(part.value);
      if (parsed !== null) dayOfMonth = parsed;
    } else if (part.type === "weekday") {
      dayOfWeek = resolveWeekday(part.value);
    } else if (part.type === "hour") {
      const parsed = parseInteger(part.value);
      if (parsed !== null) hour = parsed;
    } else if (part.type === "minute") {
      const parsed = parseInteger(part.value);
      if (parsed !== null) minute = parsed;
    }
  }

  if (
    month === undefined ||
    dayOfMonth === undefined ||
    dayOfWeek === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    return null;
  }
  return { month, dayOfMonth, dayOfWeek, hour, minute };
}

function startAtNextMinute(afterMs: number): Date {
  const date = new Date(afterMs);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  return date;
}

export function normalizeTimeZone(rawTimeZone: string): string | undefined {
  const trimmed = rawTimeZone.trim();
  if (trimmed.length === 0) return undefined;

  const cached = timeZoneNormalizationCache.get(trimmed);
  if (cached) return cached;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    const canonical = formatter.resolvedOptions().timeZone;
    if (!canonical) return undefined;
    timeZoneNormalizationCache.set(trimmed, canonical);
    timeZoneNormalizationCache.set(canonical, canonical);
    return canonical;
  } catch {
    return undefined;
  }
}

export function parseCronExpression(rawExpression: string): ParseCronExpressionResult {
  const expression = rawExpression.trim();
  if (expression.length === 0) {
    return { ok: false, reason: "empty_cron" };
  }

  const segments = expression.split(/\s+/);
  if (segments.length !== 5) {
    return { ok: false, reason: "cron_must_have_5_fields" };
  }

  const minute = parseCronField({
    raw: segments[0] ?? "",
    min: 0,
    max: 59,
  });
  if (!minute) return { ok: false, reason: "invalid_cron_minute" };

  const hour = parseCronField({
    raw: segments[1] ?? "",
    min: 0,
    max: 23,
  });
  if (!hour) return { ok: false, reason: "invalid_cron_hour" };

  const dayOfMonth = parseCronField({
    raw: segments[2] ?? "",
    min: 1,
    max: 31,
  });
  if (!dayOfMonth) return { ok: false, reason: "invalid_cron_day_of_month" };

  const month = parseCronField({
    raw: segments[3] ?? "",
    min: 1,
    max: 12,
  });
  if (!month) return { ok: false, reason: "invalid_cron_month" };

  const dayOfWeek = parseCronField({
    raw: segments[4] ?? "",
    min: 0,
    max: 7,
    normalize: normalizeDayOfWeek,
    anyValues: [0, 1, 2, 3, 4, 5, 6],
  });
  if (!dayOfWeek) return { ok: false, reason: "invalid_cron_day_of_week" };

  return {
    ok: true,
    expression: {
      source: expression,
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
    },
  };
}

function getNextCronRunAtLocal(
  expression: ParsedCronExpression,
  afterMs: number,
): number | undefined {
  const maxIterations = 600_000;
  const maxLookaheadMs = 5 * 366 * 24 * 60 * 60 * 1000;
  const deadline = afterMs + maxLookaheadMs;
  const cursor = startAtNextMinute(afterMs);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const cursorMs = cursor.getTime();
    if (!Number.isFinite(cursorMs) || cursorMs > deadline) return undefined;

    const month = cursor.getMonth() + 1;
    if (!expression.month.valueSet.has(month)) {
      const nextMonth = findNextOnOrAfter(expression.month.values, month);
      if (nextMonth === undefined) {
        const firstMonth = expression.month.values[0];
        if (firstMonth === undefined) return undefined;
        cursor.setFullYear(cursor.getFullYear() + 1, firstMonth - 1, 1);
      } else {
        cursor.setMonth(nextMonth - 1, 1);
      }
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    if (!matchesDay(expression, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getHours();
    if (!expression.hour.valueSet.has(hour)) {
      const nextHour = findNextOnOrAfter(expression.hour.values, hour);
      if (nextHour === undefined) {
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
      } else {
        cursor.setHours(nextHour, 0, 0, 0);
      }
      continue;
    }

    const minute = cursor.getMinutes();
    if (!expression.minute.valueSet.has(minute)) {
      const nextMinute = findNextOnOrAfter(expression.minute.values, minute);
      if (nextMinute === undefined) {
        cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      } else {
        cursor.setMinutes(nextMinute, 0, 0);
      }
      continue;
    }

    return cursorMs;
  }
  return undefined;
}

function snapToNextUtcHour(ms: number): number {
  const date = new Date(ms);
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(date.getUTCHours() + 1);
  return date.getTime();
}

function snapToNextUtcDay(ms: number): number {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

function getNextCronRunAtInTimeZone(
  expression: ParsedCronExpression,
  afterMs: number,
  timeZone: string,
): number | undefined {
  const formatter = getOrCreateTimeZoneFormatter(timeZone);
  const maxIterations = 600_000;
  const maxLookaheadMs = 5 * 366 * 24 * 60 * 60 * 1000;
  const deadline = afterMs + maxLookaheadMs;
  let cursorMs = startAtNextMinute(afterMs).getTime();

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (!Number.isFinite(cursorMs) || cursorMs > deadline) return undefined;
    const parts = getZonedDateParts(formatter, cursorMs);
    if (!parts) return undefined;

    if (!expression.month.valueSet.has(parts.month)) {
      cursorMs = snapToNextUtcDay(cursorMs);
      continue;
    }
    if (!matchesDayParts(expression, parts.dayOfMonth, parts.dayOfWeek)) {
      cursorMs = snapToNextUtcDay(cursorMs);
      continue;
    }
    if (!expression.hour.valueSet.has(parts.hour)) {
      cursorMs = snapToNextUtcHour(cursorMs);
      continue;
    }
    if (!expression.minute.valueSet.has(parts.minute)) {
      cursorMs += 60_000;
      continue;
    }
    return cursorMs;
  }
  return undefined;
}

export function getNextCronRunAt(
  expression: ParsedCronExpression,
  afterMs: number,
  options: NextCronRunOptions = {},
): number | undefined {
  if (!options.timeZone) {
    return getNextCronRunAtLocal(expression, afterMs);
  }
  const normalizedTimeZone = normalizeTimeZone(options.timeZone);
  if (!normalizedTimeZone) return undefined;
  return getNextCronRunAtInTimeZone(expression, afterMs, normalizedTimeZone);
}
