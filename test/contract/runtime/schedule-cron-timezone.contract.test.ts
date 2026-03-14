import { describe, expect, test } from "bun:test";
import { getNextCronRunAt, parseCronExpression } from "@brewva/brewva-runtime";

describe("schedule cron timezone boundary", () => {
  test("spring-forward skips nonexistent local hour", () => {
    const parsed = parseCronExpression("30 2 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 2026-03-08 01:59 America/New_York (EST) -> 2026-03-08T06:59:00Z
    const afterMs = Date.UTC(2026, 2, 8, 6, 59, 0, 0);
    const nextRunAt = getNextCronRunAt(parsed.expression, afterMs, {
      timeZone: "America/New_York",
    });

    // 2026-03-08 02:30 local does not exist; next match is 2026-03-09 02:30 EDT.
    expect(nextRunAt).toBe(Date.UTC(2026, 2, 9, 6, 30, 0, 0));
  });

  test("fall-back picks first 01:30 before clock rollback", () => {
    const parsed = parseCronExpression("30 1 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // 2026-11-01 01:00 America/New_York (EDT) -> 2026-11-01T05:00:00Z
    const afterMs = Date.UTC(2026, 10, 1, 5, 0, 0, 0);
    const nextRunAt = getNextCronRunAt(parsed.expression, afterMs, {
      timeZone: "America/New_York",
    });

    // First occurrence of 01:30 local on fallback day (still EDT).
    expect(nextRunAt).toBe(Date.UTC(2026, 10, 1, 5, 30, 0, 0));
  });

  test("fall-back can still hit second 01:30 after first occurrence passed", () => {
    const parsed = parseCronExpression("30 1 * * *");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // After first 01:30 EDT has passed (05:40Z), before second 01:30 EST (06:30Z).
    const afterMs = Date.UTC(2026, 10, 1, 5, 40, 0, 0);
    const nextRunAt = getNextCronRunAt(parsed.expression, afterMs, {
      timeZone: "America/New_York",
    });

    expect(nextRunAt).toBe(Date.UTC(2026, 10, 1, 6, 30, 0, 0));
  });
});
