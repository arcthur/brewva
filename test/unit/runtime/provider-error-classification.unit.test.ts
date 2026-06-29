import { describe, expect, test } from "bun:test";
import { isRetryableProviderError } from "../../../packages/brewva-runtime/src/runtime/turn/provider-error.js";

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
