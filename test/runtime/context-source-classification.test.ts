import { describe, expect, test } from "bun:test";
import { isDropRecallDegradableSource } from "../../packages/brewva-runtime/src/context/source-classification.js";
import { CONTEXT_SOURCES } from "../../packages/brewva-runtime/src/context/sources.js";

describe("context source classification", () => {
  test("classifies drop_recall degradable sources", () => {
    expect(isDropRecallDegradableSource(CONTEXT_SOURCES.memoryRecall)).toBe(true);
    expect(isDropRecallDegradableSource(CONTEXT_SOURCES.ragExternal)).toBe(true);
  });

  test("keeps non-recall sources out of drop_recall degradable set", () => {
    expect(isDropRecallDegradableSource(CONTEXT_SOURCES.identity)).toBe(false);
    expect(isDropRecallDegradableSource(CONTEXT_SOURCES.taskState)).toBe(false);
    expect(isDropRecallDegradableSource("unknown.source")).toBe(false);
  });
});
