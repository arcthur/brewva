import { describe, expect, test } from "bun:test";
import { scoreDocumentsByTfIdf } from "@brewva/brewva-search";

describe("TF-IDF search ranking", () => {
  test("ranks documents using shared search tokenization", () => {
    const results = scoreDocumentsByTfIdf("runtime trace evidence", [
      {
        id: "architecture",
        text: "Architecture boundaries and module depth.",
      },
      {
        id: "runtime-forensics",
        text: "Runtime trace evidence, event streams, ledgers, and projections.",
      },
    ]);

    expect(results[0]?.document.id).toBe("runtime-forensics");
    expect(results[0]?.matchedTokens).toEqual(
      expect.arrayContaining(["runtime", "trace", "evidence"]),
    );
  });

  test("uses CJK tokens from the shared tokenizer", () => {
    const results = scoreDocumentsByTfIdf("运行时 证据", [
      {
        id: "runtime-forensics",
        text: "运行时 证据 轨迹",
      },
    ]);

    expect(results[0]?.document.id).toBe("runtime-forensics");
    expect(results[0]?.score).toBeGreaterThan(0);
  });
});
