import { describe, expect, test } from "bun:test";
import {
  describeProviderFailure,
  isProviderAccessFailureAttempt,
  readProviderFailureAttempts,
} from "../../../packages/brewva-cli/src/shell/domain/provider-failure-guidance.js";

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

  test("gives a wait-and-retry notice for a transient connection failure", () => {
    const text = describeProviderFailure(new Error("Connection error."));
    expect(text).toContain("Connection error.");
    expect(text).toContain("Wait a few seconds and send it again.");
    expect(text).not.toContain("/model");
  });

  test("recognizes connection refused / reset / socket errors as transient", () => {
    expect(
      describeProviderFailure(new Error("Connection error. <- Error (ECONNREFUSED)")),
    ).toContain("transient network");
    expect(
      describeProviderFailure(Object.assign(new Error("socket hang up"), { retryable: true })),
    ).toContain("transient network");
  });

  test("permanent access failure takes precedence over connection phrasing", () => {
    const error = Object.assign(new Error("401 unauthorized: connection error"), {
      retryable: false,
    });
    const text = describeProviderFailure(error);
    expect(text).toContain("/model");
    expect(text).not.toContain("Wait a few seconds");
  });

  test("falls back to a generic message for a non-error value", () => {
    expect(describeProviderFailure(undefined)).toBe("Failed to run prompt.");
  });
});

describe("readProviderFailureAttempts", () => {
  test("reads a well-formed fallback attempt trail off the error", () => {
    const error = Object.assign(new Error("exhausted"), {
      attempts: [
        {
          provider: "openai-codex",
          model: "gpt-5.5-pro",
          message: "The 'gpt-5.5-pro' model is not supported.",
          retryable: false,
        },
        { provider: "openai-codex", model: "gpt-5.1-codex-mini", message: "rejected" },
      ],
    });
    expect(readProviderFailureAttempts(error)).toEqual([
      {
        provider: "openai-codex",
        model: "gpt-5.5-pro",
        message: "The 'gpt-5.5-pro' model is not supported.",
        retryable: false,
      },
      { provider: "openai-codex", model: "gpt-5.1-codex-mini", message: "rejected" },
    ]);
  });

  test("yields an empty trail for absent, non-array, or malformed attempts", () => {
    expect(readProviderFailureAttempts(new Error("plain"))).toEqual([]);
    expect(readProviderFailureAttempts(undefined)).toEqual([]);
    expect(readProviderFailureAttempts(Object.assign(new Error("x"), { attempts: "no" }))).toEqual(
      [],
    );
    // One malformed entry rejects the whole trail — a partially trusted trail
    // could mark the wrong model unavailable.
    expect(
      readProviderFailureAttempts(
        Object.assign(new Error("x"), {
          attempts: [{ provider: "openai-codex", model: 42, message: "bad" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("isProviderAccessFailureAttempt", () => {
  test("the structured flag is authoritative over message phrasing", () => {
    expect(
      isProviderAccessFailureAttempt({
        provider: "p",
        model: "m",
        message: "rate limited; check your api key quota",
        retryable: true,
      }),
    ).toBe(false);
    expect(
      isProviderAccessFailureAttempt({
        provider: "p",
        model: "m",
        message: "some opaque failure",
        retryable: false,
      }),
    ).toBe(true);
  });

  test("without the flag the attempt's own message decides", () => {
    expect(
      isProviderAccessFailureAttempt({
        provider: "p",
        model: "m",
        message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
      }),
    ).toBe(true);
    expect(
      isProviderAccessFailureAttempt({ provider: "p", model: "m", message: "socket hang up" }),
    ).toBe(false);
  });
});
