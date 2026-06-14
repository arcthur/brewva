import { describe, expect, test } from "bun:test";
import { detectContentShape } from "@brewva/brewva-std/content-shape";

describe("detectContentShape", () => {
  test("detects a unified diff with high confidence", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index e69de29..4b825dc 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed line",
      "+added line",
      "+another added line",
    ].join("\n");

    const result = detectContentShape(diff);

    expect(result.shape).toBe("unified_diff");
    expect(result.confidence).toBe("high");
    expect(result.estimatedReductionRatio).toBeGreaterThan(0);
    expect(result.indicators).toContain("hunk_header");
  });

  test("detects a JSON array", () => {
    const json = JSON.stringify([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
      { id: 3, name: "gamma" },
    ]);

    const result = detectContentShape(json);

    expect(result.shape).toBe("json_array");
    expect(result.confidence).toBe("high");
    expect(result.estimatedReductionRatio).toBeGreaterThan(0);
  });

  test("detects a build log by its level markers and stack frames", () => {
    const log = [
      "2026-06-14T10:00:00Z INFO building package",
      "2026-06-14T10:00:01Z WARN deprecated api used",
      "2026-06-14T10:00:02Z ERROR compilation failed",
      "    at compile (src/build.ts:42:7)",
      "    at run (src/cli.ts:10:3)",
      "2026-06-14T10:00:03Z INFO build finished with errors",
    ].join("\n");

    const result = detectContentShape(log);

    expect(result.shape).toBe("build_log");
    expect(result.estimatedReductionRatio).toBeGreaterThan(0);
  });

  test("detects grep-style search results", () => {
    const results = [
      "src/foo.ts:12:  const value = compute();",
      "src/bar.ts:48:  return compute(value);",
      "src/baz.ts:7:  // compute the thing",
      "test/foo.test.ts:90:  expect(compute()).toBe(1);",
    ].join("\n");

    const result = detectContentShape(results);

    expect(result.shape).toBe("search_results");
    expect(result.estimatedReductionRatio).toBeGreaterThan(0);
  });

  test("treats natural-language paragraphs as prose with a low reduction ratio", () => {
    const prose =
      "The compaction policy keeps recent turns intact while older spans become " +
      "eligible for eviction. This preserves continuity without letting the prompt " +
      "grow without bound, and it keeps the cache prefix stable across turns.";

    const result = detectContentShape(prose);

    expect(result.shape).toBe("prose");
    expect(result.estimatedReductionRatio).toBeLessThan(0.5);
  });

  test("returns unknown with a zero reduction ratio for empty content", () => {
    const result = detectContentShape("   ");

    expect(result.shape).toBe("unknown");
    expect(result.estimatedReductionRatio).toBe(0);
  });
});
