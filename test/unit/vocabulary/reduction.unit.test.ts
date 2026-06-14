import { describe, expect, test } from "bun:test";
import { buildReductionCandidate } from "@brewva/brewva-vocabulary/reduction";

const BUILD_LOG = [
  "2026-06-14T10:00:00Z INFO building package",
  "2026-06-14T10:00:01Z WARN deprecated api used",
  "2026-06-14T10:00:02Z ERROR compilation failed",
  "    at compile (src/build.ts:42:7)",
  "2026-06-14T10:00:03Z INFO build finished with errors",
].join("\n");

describe("buildReductionCandidate", () => {
  test("builds an inspectable candidate for reducible content", () => {
    const candidate = buildReductionCandidate({ spanRef: "message:5", content: BUILD_LOG });

    expect(candidate).not.toBeNull();
    expect(candidate?.spanRef).toBe("message:5");
    expect(candidate?.detectedShape).toBe("build_log");
    expect(candidate?.estimatedTokensSaved).toBeGreaterThan(0);
    expect(candidate?.suggestedReduction.length).toBeGreaterThan(0);
    expect(candidate?.confidence).toBe("high");
    expect(candidate?.indicators).toContain("log_levels");
  });

  test("returns null for content with no worthwhile reduction (prose/unknown)", () => {
    expect(buildReductionCandidate({ spanRef: "m1", content: "ok" })).toBeNull();
    expect(
      buildReductionCandidate({
        spanRef: "m2",
        content:
          "This is an ordinary explanatory paragraph describing how the policy works in plain prose.",
      }),
    ).toBeNull();
  });

  test("classifies a JSON array as a reducible candidate", () => {
    const json = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]);

    const candidate = buildReductionCandidate({ spanRef: "event:e1", content: json });

    expect(candidate?.detectedShape).toBe("json_array");
    expect(candidate?.estimatedTokensSaved).toBeGreaterThan(0);
  });
});
