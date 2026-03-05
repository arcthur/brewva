import { describe, expect, test } from "bun:test";
import { CONTEXT_SOURCES } from "../../packages/brewva-runtime/src/context/sources.js";

describe("context sources contract", () => {
  test("defines unique source ids", () => {
    const sourceValues = Object.values(CONTEXT_SOURCES);
    const unique = new Set(sourceValues);
    expect(unique.size).toBe(sourceValues.length);
  });

  test("does not expose recall/external semantic sources", () => {
    const sourceValues = Object.values(CONTEXT_SOURCES) as string[];
    expect(sourceValues.includes("brewva.memory-recall")).toBe(false);
    expect(sourceValues.includes("brewva.rag-external")).toBe(false);
  });
});
