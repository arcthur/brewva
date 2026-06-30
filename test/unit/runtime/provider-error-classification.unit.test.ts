import { describe, expect, test } from "bun:test";
import {
  describeProviderError,
  isRetryableProviderError,
} from "../../../packages/brewva-runtime/src/runtime/turn/provider-error.js";

describe("isRetryableProviderError", () => {
  test("non-retryable when the top-level error is flagged false", () => {
    expect(isRetryableProviderError(Object.assign(new Error("x"), { retryable: false }))).toBe(
      false,
    );
  });

  test("non-retryable when a nested cause is flagged false", () => {
    const inner = Object.assign(new Error("permanent"), { retryable: false });
    const wrapper = Object.assign(new Error("wrapper"), { cause: inner });
    expect(isRetryableProviderError(wrapper)).toBe(false);
  });

  test("fails safe: a non-retryable inner cause wins over a retryable outer wrapper", () => {
    const inner = Object.assign(new Error("permanent"), { retryable: false });
    const outer = Object.assign(new Error("wrapper"), { retryable: true, cause: inner });
    expect(isRetryableProviderError(outer)).toBe(false);
  });

  test("retryable for an unclassified error (preserves retry-once default)", () => {
    expect(isRetryableProviderError(new Error("transient blip"))).toBe(true);
  });

  test("retryable for a non-object value", () => {
    expect(isRetryableProviderError("oops")).toBe(true);
  });
});

describe("describeProviderError", () => {
  test("joins the whole cause chain so an opaque top-level message keeps its real reason", () => {
    // Shape of a real OpenAI SDK APIConnectionError over a bun fetch failure:
    // "Connection error." <- TypeError: fetch failed <- the actual socket errno.
    const root = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
    const fetchErr = Object.assign(new TypeError("fetch failed"), { cause: root });
    const apiErr = Object.assign(new Error("Connection error."), { cause: fetchErr });
    expect(describeProviderError(apiErr)).toBe(
      "Connection error. <- TypeError: fetch failed <- connect ECONNRESET (ECONNRESET)",
    );
  });

  test("returns a plain string error unchanged and falls back when there is no message", () => {
    expect([
      describeProviderError("boom"),
      describeProviderError({}),
      describeProviderError(undefined, "provider_stream_failed"),
    ]).toEqual(["boom", "runtime_turn_failed", "provider_stream_failed"]);
  });

  test("is cycle-safe", () => {
    const cyclic = new Error("loops") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(describeProviderError(cyclic)).toBe("loops");
  });
});
