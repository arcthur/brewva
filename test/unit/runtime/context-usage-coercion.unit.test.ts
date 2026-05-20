import { describe, expect, test } from "bun:test";
import { coerceContextBudgetUsage } from "@brewva/brewva-runtime/protocol";

describe("coerceContextBudgetUsage", () => {
  test("returns undefined when input is missing or invalid", () => {
    expect([
      coerceContextBudgetUsage(undefined),
      coerceContextBudgetUsage(null),
      coerceContextBudgetUsage(42),
      coerceContextBudgetUsage("usage"),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("requires a finite positive contextWindow", () => {
    expect([
      coerceContextBudgetUsage({ tokens: 100 }),
      coerceContextBudgetUsage({ tokens: 100, contextWindow: 0 }),
      coerceContextBudgetUsage({ tokens: 100, contextWindow: Number.NaN }),
      coerceContextBudgetUsage({ tokens: 100, contextWindow: Number.POSITIVE_INFINITY }),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  test("normalizes tokens, contextWindow, and percent fields", () => {
    expect(
      coerceContextBudgetUsage({
        tokens: 1000,
        contextWindow: 4000,
        percent: 0.25,
      }),
    ).toEqual({
      tokens: 1000,
      contextWindow: 4000,
      percent: 0.25,
      maxOutputTokens: null,
    });
  });

  test("preserves a finite positive maxOutputTokens", () => {
    expect(
      coerceContextBudgetUsage({
        tokens: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
      }),
    ).toMatchObject({ maxOutputTokens: 32_768 });
  });

  test("rejects non-positive maxOutputTokens", () => {
    expect(
      coerceContextBudgetUsage({
        tokens: 0,
        contextWindow: 200_000,
        maxOutputTokens: 0,
      }),
    ).toMatchObject({ maxOutputTokens: null });

    expect(
      coerceContextBudgetUsage({
        tokens: 0,
        contextWindow: 200_000,
        maxOutputTokens: -1000,
      }),
    ).toMatchObject({ maxOutputTokens: null });

    expect(
      coerceContextBudgetUsage({
        tokens: 0,
        contextWindow: 200_000,
        maxOutputTokens: Number.NaN,
      }),
    ).toMatchObject({ maxOutputTokens: null });
  });

  test("treats negative tokens as null", () => {
    const result = coerceContextBudgetUsage({
      tokens: -50,
      contextWindow: 4000,
    });
    expect(result?.tokens).toBeNull();
  });
});
