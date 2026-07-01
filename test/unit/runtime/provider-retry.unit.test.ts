import { describe, expect, test } from "bun:test";
import {
  PROVIDER_RETRY_MAX_ATTEMPTS,
  isRetryableProviderError,
  providerRetryDelayMs,
} from "../../../packages/brewva-runtime/src/runtime/turn/provider-error.js";

describe("provider retry backoff schedule", () => {
  test("exponential backoff from 500ms, capped at 2s", () => {
    const schedule = [1, 2, 3].map(providerRetryDelayMs);
    expect(schedule).toEqual([500, 1000, 2000]);
  });

  test("caps every attempt beyond the ceiling at 2s", () => {
    expect(providerRetryDelayMs(3)).toBe(2000);
    expect(providerRetryDelayMs(20)).toBe(2000);
  });

  test("first attempt uses the base delay", () => {
    expect(providerRetryDelayMs(1)).toBe(500);
  });

  test("the full attempt budget spans ~1.5s of backoff (short, fail-fast)", () => {
    const total = Array.from({ length: PROVIDER_RETRY_MAX_ATTEMPTS }, (_, i) =>
      providerRetryDelayMs(i + 1),
    ).reduce((sum, ms) => sum + ms, 0);
    expect(total).toBe(1_500);
  });
});

describe("provider retry gate (isRetryableProviderError)", () => {
  test("retries an unclassified transient failure — no flag means retryable", () => {
    // ConnectionRefused / "Connection error." carry no HTTP status, so no
    // retryable flag is set; the gate must treat them as retryable.
    expect(isRetryableProviderError(new Error("Connection error."))).toBe(true);
  });

  test("does NOT retry a permanent failure flagged retryable:false (e.g. 401)", () => {
    const authError = Object.assign(new Error("Unauthorized"), { retryable: false });
    expect(isRetryableProviderError(authError)).toBe(false);
  });

  test("honors retryable:false buried deep in the cause chain", () => {
    const permanent = { retryable: false };
    const wrapped = { message: "wrapper", cause: { message: "mid", cause: permanent } };
    expect(isRetryableProviderError(wrapped)).toBe(false);
  });

  test("treats an explicit retryable:true as retryable", () => {
    expect(isRetryableProviderError({ retryable: true })).toBe(true);
  });

  test("non-object errors are retryable (absent flag)", () => {
    expect(isRetryableProviderError("boom")).toBe(true);
    expect(isRetryableProviderError(null)).toBe(true);
    expect(isRetryableProviderError(undefined)).toBe(true);
  });
});
