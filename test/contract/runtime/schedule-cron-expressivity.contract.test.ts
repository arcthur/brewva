import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { getNextCronRunAt, parseCronExpression } from "@brewva/brewva-vocabulary/schedule";

describe("cron expressivity (the forms the product actually emits)", () => {
  test("accepts the forms emitted by follow-up, self-improve, and yearly schedules", () => {
    for (const cron of ["*/5 * * * *", "0 */2 * * *", "0 9 * * 1", "0 9 * * 7", "0 0 1 1 *"]) {
      expect(parseCronExpression(cron).ok).toBe(true);
    }
  });

  test("rejects out-of-range, zero-step, ranges, lists, and wrong field counts", () => {
    for (const cron of [
      "60 9 * * *", // minute out of range
      "0 24 * * *", // hour out of range
      "0 9 * * 8", // day-of-week out of range (max 7)
      "*/0 * * * *", // zero step
      "1-5 9 * * *", // ranges unsupported
      "0 1,3 * * *", // lists unsupported
      "0 9 * *", // wrong field count
    ]) {
      expect(parseCronExpression(cron).ok).toBe(false);
    }
  });

  test("the shipped self-improve default cron parses (it previously did not)", () => {
    expect(parseCronExpression(DEFAULT_BREWVA_CONFIG.schedule.selfImprove.cron).ok).toBe(true);
  });

  test("step minutes advance to the next boundary", () => {
    // 12:02:30Z -> rounds to 12:03 -> next */5 boundary is 12:05.
    const next = getNextCronRunAt("*/5 * * * *", Date.UTC(2026, 5, 1, 12, 2, 30, 0), {
      timeZone: "UTC",
    });
    expect(next.getTime()).toBe(Date.UTC(2026, 5, 1, 12, 5, 0, 0));
  });

  test("step hours advance to the next even hour at minute zero", () => {
    const next = getNextCronRunAt("0 */2 * * *", Date.UTC(2026, 5, 1, 13, 0, 0, 0), {
      timeZone: "UTC",
    });
    expect(next.getTime()).toBe(Date.UTC(2026, 5, 1, 14, 0, 0, 0));
  });

  test("day-of-week selects the next matching weekday", () => {
    const from = Date.UTC(2026, 5, 2, 0, 0, 0, 0); // a Tuesday
    const next = getNextCronRunAt("0 9 * * 1", from, { timeZone: "UTC" });
    expect(next.getUTCDay()).toBe(1); // Monday
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(from);
  });

  test("day-of-week 7 is Sunday (normalized to 0)", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
    const sundayVia7 = getNextCronRunAt("0 9 * * 7", from, { timeZone: "UTC" });
    const sundayVia0 = getNextCronRunAt("0 9 * * 0", from, { timeZone: "UTC" });
    expect(sundayVia7.getUTCDay()).toBe(0);
    expect(sundayVia7.getTime()).toBe(sundayVia0.getTime());
  });

  test("day-of-month plus month selects the yearly slot", () => {
    const next = getNextCronRunAt("0 0 1 1 *", Date.UTC(2026, 5, 1, 0, 0, 0, 0), {
      timeZone: "UTC",
    });
    expect(next.getTime()).toBe(Date.UTC(2027, 0, 1, 0, 0, 0, 0));
  });
});
