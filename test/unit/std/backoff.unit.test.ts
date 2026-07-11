import { describe, expect, test } from "bun:test";
import {
  computeBackoffMs,
  deterministicJitterFraction,
  parseRetryAfterMs,
} from "@brewva/brewva-std/backoff";

describe("std backoff kernel", () => {
  test("computeBackoffMs grows exponentially and caps at maxMs", () => {
    const options = { baseMs: 500, factor: 2, maxMs: 2000 };
    expect(computeBackoffMs(0, options)).toBe(500);
    expect(computeBackoffMs(1, options)).toBe(1000);
    expect(computeBackoffMs(2, options)).toBe(2000);
    expect(computeBackoffMs(3, options)).toBe(2000); // capped
    expect(computeBackoffMs(10, options)).toBe(2000); // capped
  });

  test("computeBackoffMs clamps the exponent to >= 0 for 1-based callers", () => {
    const options = { baseMs: 500, factor: 2, maxMs: 2000 };
    // A 1-based caller passing attempt-1 lands on -1 for its first try.
    expect(computeBackoffMs(-1, options)).toBe(500);
    expect(computeBackoffMs(-5, options)).toBe(500);
  });

  test("computeBackoffMs is uncapped when maxMs is omitted", () => {
    expect(computeBackoffMs(4, { baseMs: 1000, factor: 2 })).toBe(16_000);
  });

  test("parseRetryAfterMs reads delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("1.5")).toBe(1500);
    expect(parseRetryAfterMs("  30  ")).toBe(30_000);
  });

  test("parseRetryAfterMs reads an HTTP-date relative to nowMs and never goes negative", () => {
    const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
    expect(parseRetryAfterMs("Wed, 21 Oct 2025 07:28:10 GMT", now)).toBe(10_000);
    // A past date clamps to 0 rather than returning a negative delay.
    expect(parseRetryAfterMs("Wed, 21 Oct 2025 07:27:00 GMT", now)).toBe(0);
  });

  test("parseRetryAfterMs returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfterMs(null)).toBe(undefined);
    expect(parseRetryAfterMs(undefined)).toBe(undefined);
    expect(parseRetryAfterMs("")).toBe(undefined);
    expect(parseRetryAfterMs("   ")).toBe(undefined);
    expect(parseRetryAfterMs("not-a-date")).toBe(undefined);
  });

  test("deterministicJitterFraction is stable, in [0, 1), and seed-sensitive", () => {
    expect(deterministicJitterFraction("session:3")).toBe(deterministicJitterFraction("session:3"));
    const fraction = deterministicJitterFraction("session:3");
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThan(1);
    expect(deterministicJitterFraction("session:3")).not.toBe(
      deterministicJitterFraction("session:4"),
    );
  });
});
