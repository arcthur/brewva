import { describe, expect, test } from "bun:test";
import { summarizeReasoning } from "../../../packages/brewva-cli/runtime/shell/reasoning-summary.js";

describe("summarizeReasoning", () => {
  test("empty text has no title and nothing to hide", () => {
    expect(summarizeReasoning("   ")).toEqual({ title: "", hasMore: false });
  });

  test("lifts a leading **bold** line as the title", () => {
    const result = summarizeReasoning("**Checking the retry helper**\n\nThe backoff is linear.");
    expect(result.title).toBe("Checking the retry helper");
    expect(result.hasMore).toBe(true);
  });

  test("a bold title with no body still has a title but nothing more", () => {
    const result = summarizeReasoning("**Just a heading**");
    expect(result.title).toBe("Just a heading");
    expect(result.hasMore).toBe(false);
  });

  test("falls back to the first non-empty line when there is no bold lead", () => {
    const result = summarizeReasoning("First I will read the file.\nThen edit it.");
    expect(result.title).toBe("First I will read the file.");
    expect(result.hasMore).toBe(true);
  });

  test("a single short line has a title but nothing to hide", () => {
    const result = summarizeReasoning("Quick thought.");
    expect(result.title).toBe("Quick thought.");
    expect(result.hasMore).toBe(false);
  });

  test("truncates a very long title and flags it as having more", () => {
    const long = "x".repeat(100);
    const result = summarizeReasoning(long);
    expect(result.title).toBe(`${"x".repeat(80)}…`);
    expect(result.hasMore).toBe(true);
  });

  test("skips leading blank lines to find the title", () => {
    const result = summarizeReasoning("\n\n  Real first line\nmore");
    expect(result.title).toBe("Real first line");
    expect(result.hasMore).toBe(true);
  });
});
