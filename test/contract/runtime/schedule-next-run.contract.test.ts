import { describe, expect, test } from "bun:test";
import { getNextCronRunAt, nextScheduleRunAt } from "@brewva/brewva-vocabulary/schedule";

const MAX_RECURRING_JITTER_MS = 15 * 60 * 1000;
const JITTER_INTERVAL_RATIO = 0.1;

function exactCronSlot(cron: string, fromMs: number, timeZone: string): number {
  return getNextCronRunAt(cron, fromMs, { timeZone }).getTime();
}

// Independent oracle for the interval-relative jitter contract (FNV-1a fraction of
// the cron interval, capped). Authored separately from the implementation so the
// test validates the formula rather than restating it.
function fnvFraction(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

function expectedJitteredNext(
  cron: string,
  fromMs: number,
  timeZone: string,
  intentId: string,
): number {
  const exact = exactCronSlot(cron, fromMs, timeZone);
  const following = exactCronSlot(cron, exact, timeZone);
  const intervalMs = following - exact;
  const jitterMs = Math.floor(
    Math.min(MAX_RECURRING_JITTER_MS, intervalMs * JITTER_INTERVAL_RATIO * fnvFraction(intentId)),
  );
  return exact + jitterMs;
}

describe("nextScheduleRunAt", () => {
  test("returns a one-shot runAt verbatim", () => {
    const runAt = Date.UTC(2026, 5, 1, 12, 0, 0, 0);
    expect(nextScheduleRunAt({ runAt })).toBe(runAt);
  });

  test("returns null when neither runAt nor cron is present", () => {
    expect(nextScheduleRunAt({})).toBeNull();
  });

  test("returns null for an unparseable cron (ranges and lists remain unsupported)", () => {
    expect(nextScheduleRunAt({ cron: "0-30 9 * * *" })).toBeNull();
    expect(nextScheduleRunAt({ cron: "0 9 * * 8" })).toBeNull(); // day-of-week out of range
  });

  test("anchors on the next timezone-correct cron slot across DST, jittered forward", () => {
    // 2026-03-08 01:59 America/New_York (EST) -> 06:59Z; 02:30 local is skipped by
    // spring-forward, so the exact next slot is 2026-03-09 02:30 EDT (06:30Z).
    const from = Date.UTC(2026, 2, 8, 6, 59, 0, 0);
    const exact = Date.UTC(2026, 2, 9, 6, 30, 0, 0);
    expect(exactCronSlot("30 2 * * *", from, "America/New_York")).toBe(exact);

    const next = nextScheduleRunAt({ cron: "30 2 * * *", timeZone: "America/New_York" }, { from });
    expect(typeof next).toBe("number");
    if (typeof next === "number") {
      expect(next).toBeGreaterThanOrEqual(exact); // never before the slot
      expect(next).toBeLessThanOrEqual(exact + MAX_RECURRING_JITTER_MS); // capped (inclusive)
    }
  });

  test("is deterministic per intent (the persisted nextRunAt survives replay)", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
    const args = { cron: "0 9 * * *", timeZone: "UTC", intentId: "intent-A" } as const;
    expect(nextScheduleRunAt(args, { from })).toBe(nextScheduleRunAt(args, { from }));
  });

  test("matches the interval-relative jittered cron formula for known intents", () => {
    const from = Date.UTC(2026, 5, 1, 0, 0, 0, 0);
    for (const intentId of ["intent-A", "intent-B", "nightly", "weekly-report"]) {
      const next = nextScheduleRunAt({ cron: "0 9 * * *", timeZone: "UTC", intentId }, { from });
      expect(next).toBe(expectedJitteredNext("0 9 * * *", from, "UTC", intentId));
    }
  });
});
