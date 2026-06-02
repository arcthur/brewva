import { describe, expect, test } from "bun:test";
import { sanitizeDroppedDigestLines } from "../../../packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.js";

describe("compaction summary dropped digest sanitizer", () => {
  test("removes non-allowlisted dropped digests and preserves allowlisted lines", () => {
    const summary = [
      "1. Current Objective",
      "- Continue the task.",
      "5. Dropped Digests",
      "- digest=keep_digest because it was compacted.",
      "- digest=drop_digest was invented by the model.",
      "- no digest marker remains as prose.",
      "6. Next Evidence",
      "- digest=drop_digest outside Dropped Digests is not a drop claim.",
    ].join("\n");

    expect(sanitizeDroppedDigestLines(summary, new Set(["keep_digest"]))).toBe(
      [
        "1. Current Objective",
        "- Continue the task.",
        "5. Dropped Digests",
        "- digest=keep_digest because it was compacted.",
        "- no digest marker remains as prose.",
        "6. Next Evidence",
        "- digest=drop_digest outside Dropped Digests is not a drop claim.",
      ].join("\n"),
    );
  });
});
