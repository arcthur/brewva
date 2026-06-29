import { describe, expect, test } from "bun:test";
import { describeProviderFailure } from "../../../packages/brewva-cli/src/shell/domain/provider-failure-guidance.js";

describe("describeProviderFailure", () => {
  test("appends actionable guidance for a non-retryable provider failure", () => {
    const error = Object.assign(
      new Error(
        "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
      ),
      { retryable: false },
    );
    const text = describeProviderFailure(error);
    expect(text).toContain("not supported when using Codex");
    expect(text).toContain("/model");
  });

  test("recognizes an access failure from the message when retryable is absent", () => {
    const text = describeProviderFailure(new Error("401 Unauthorized: invalid api key"));
    expect(text).toContain("/model");
  });

  test("leaves an ordinary transient failure unembellished", () => {
    const text = describeProviderFailure(
      Object.assign(new Error("service unavailable"), { retryable: true }),
    );
    expect(text).toBe("service unavailable");
    expect(text).not.toContain("/model");
  });

  test("treats an explicit retryable:true as transient even when the message mentions credentials", () => {
    // Regression: the structured flag must win over the message regex. A transient
    // failure (e.g. a rate-limit notice that happens to mention "api key") must not
    // be mis-classified as a permanent access failure and badged Unavailable.
    const text = describeProviderFailure(
      Object.assign(new Error("429 rate limited; check your api key quota and retry"), {
        retryable: true,
      }),
    );
    expect(text).toBe("429 rate limited; check your api key quota and retry");
    expect(text).not.toContain("/model");
  });

  test("falls back to a generic message for a non-error value", () => {
    expect(describeProviderFailure(undefined)).toBe("Failed to run prompt.");
  });
});
