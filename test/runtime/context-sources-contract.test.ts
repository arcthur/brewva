import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SOURCES,
  DROP_RECALL_DEGRADABLE_SOURCES,
} from "../../packages/brewva-runtime/src/context/sources.js";

describe("context sources contract", () => {
  test("defines unique source ids", () => {
    const sourceValues = Object.values(CONTEXT_SOURCES);
    const unique = new Set(sourceValues);
    expect(unique.size).toBe(sourceValues.length);
  });

  test("drop_recall degradable set includes only recall-tier sources", () => {
    expect(DROP_RECALL_DEGRADABLE_SOURCES).toEqual([
      CONTEXT_SOURCES.memoryRecall,
      CONTEXT_SOURCES.ragExternal,
    ]);
  });
});
