import { describe, expect, test } from "bun:test";
import {
  classifyProviderFailure,
  nextRateLimitBackoffMs,
  readProviderErrorStatus,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-provider.js";

describe("readProviderErrorStatus", () => {
  test("reads a numeric status off the error or its cause chain", () => {
    expect(readProviderErrorStatus({ status: 429 })).toBe(429);
    expect(readProviderErrorStatus({ statusCode: 503 })).toBe(503);
    expect(readProviderErrorStatus({ cause: { status: 402 } })).toBe(402);
    expect(readProviderErrorStatus({ cause: { cause: { status: 401 } } })).toBe(401);
  });

  test("ignores missing, non-numeric, or out-of-range statuses", () => {
    expect(readProviderErrorStatus(undefined)).toBe(undefined);
    expect(readProviderErrorStatus("rate limited")).toBe(undefined);
    expect(readProviderErrorStatus({ status: "429" })).toBe(undefined);
    expect(readProviderErrorStatus({ status: 42 })).toBe(undefined);
    expect(readProviderErrorStatus({ status: 600 })).toBe(undefined);
  });

  test("is depth-bounded against a cyclic cause chain", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(readProviderErrorStatus(cyclic)).toBe(undefined);
  });
});

// In production the error reaching `classifyProviderFailure` is always an Error (a
// `ProviderStreamError` whose `cause` holds the SDK error, or a `new Error(message)`),
// so the cases below use Error instances with the status attached the way it arrives.
function errorWith(message: string, extra: Record<string, unknown>): Error {
  return Object.assign(new Error(message), extra);
}

describe("classifyProviderFailure (status-first, regex fallback)", () => {
  test("classifies from an unambiguous HTTP status even when the message is generic", () => {
    expect(
      classifyProviderFailure(errorWith("Service responded with an error", { status: 429 })),
    ).toBe("rate_limit");
    // A 402 worded as "Payment Required" carries no quota/billing token; the message
    // regex would miss it and return "unknown" -- the status fixes that.
    expect(classifyProviderFailure(errorWith("Payment Required", { status: 402 }))).toBe("quota");
    expect(classifyProviderFailure(errorWith("nope", { status: 401 }))).toBe("auth");
    expect(classifyProviderFailure(errorWith("nope", { status: 403 }))).toBe("auth");
    expect(classifyProviderFailure(errorWith("nope", { status: 503 }))).toBe("provider");
    expect(classifyProviderFailure(errorWith("nope", { status: 529 }))).toBe("provider"); // overloaded
    expect(classifyProviderFailure(errorWith("nope", { status: 408 }))).toBe("provider");
  });

  test("reads the status off the cause chain (the ProviderStreamError shape)", () => {
    expect(classifyProviderFailure(errorWith("Request failed", { cause: { status: 429 } }))).toBe(
      "rate_limit",
    );
  });

  test("defers an ambiguous 4xx to the message regex", () => {
    // A 400 may be a context-length error -- let the message decide.
    expect(
      classifyProviderFailure(errorWith("maximum context length exceeded", { status: 400 })),
    ).toBe("context");
    expect(classifyProviderFailure(errorWith("rate limit reached", { status: 413 }))).toBe(
      "rate_limit",
    );
  });

  test("falls back to the message regex when no status is present (no regression)", () => {
    expect(classifyProviderFailure(new Error("Rate limit exceeded, try again"))).toBe("rate_limit");
    expect(classifyProviderFailure(new Error("insufficient_quota"))).toBe("quota");
    expect(classifyProviderFailure(new Error("unauthorized: bad api key"))).toBe("auth");
    expect(classifyProviderFailure(new Error("service unavailable"))).toBe("provider");
    expect(classifyProviderFailure(new Error("something weird"))).toBe("unknown");
  });
});

describe("nextRateLimitBackoffMs (full-jittered)", () => {
  test("is off by default (no config, or maxRetries 0)", () => {
    expect(nextRateLimitBackoffMs(0, undefined, 0.5)).toBe(undefined);
    expect(
      nextRateLimitBackoffMs(0, { maxRetries: 0, baseDelayMs: 1_000, maxDelayMs: 30_000 }, 0.5),
    ).toBe(undefined);
  });

  test("samples the exponential ceiling by the jitter fraction until exhausted", () => {
    const config = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    // The ceiling doubles per attempt (1000, 2000, 4000); fraction 0.5 picks its midpoint.
    expect(nextRateLimitBackoffMs(0, config, 0.5)).toBe(500);
    expect(nextRateLimitBackoffMs(1, config, 0.5)).toBe(1_000);
    expect(nextRateLimitBackoffMs(2, config, 0.5)).toBe(2_000);
    expect(nextRateLimitBackoffMs(3, config, 0.5)).toBe(undefined); // exhausted, fraction aside
  });

  test("caps the ceiling at maxDelayMs before jittering", () => {
    const config = { maxRetries: 10, baseDelayMs: 1_000, maxDelayMs: 5_000 };
    expect(nextRateLimitBackoffMs(0, config, 0.5)).toBe(500); // ceiling 1000
    expect(nextRateLimitBackoffMs(3, config, 0.5)).toBe(2_500); // 8000 capped to 5000
    expect(nextRateLimitBackoffMs(9, config, 0.5)).toBe(2_500);
  });

  test("stays within [0, ceiling) and decorrelates by fraction", () => {
    const config = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    // fraction 0 retries immediately; a near-1 fraction approaches but never reaches the
    // ceiling, so two callers with different fractions never share a wake time.
    expect(nextRateLimitBackoffMs(0, config, 0)).toBe(0);
    expect(nextRateLimitBackoffMs(0, config, 0.999)).toBe(999);
    expect(nextRateLimitBackoffMs(0, config, 0.1)).not.toBe(nextRateLimitBackoffMs(0, config, 0.9));
  });

  test("clamps an out-of-range or non-finite fraction instead of overshooting", () => {
    const config = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    expect(nextRateLimitBackoffMs(0, config, -0.5)).toBe(0); // clamped up to 0
    expect(nextRateLimitBackoffMs(0, config, 1.5)).toBe(1_000); // clamped down to the ceiling
    expect(nextRateLimitBackoffMs(0, config, Number.NaN)).toBe(0); // non-finite -> 0
  });
});
