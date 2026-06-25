import { describe, expect, test } from "bun:test";
import { deriveAutoCompactionIneffectiveFromReceipts } from "../../../packages/brewva-gateway/src/hosted/internal/context/auto-compaction-ineffective.js";

function receipt(sourceTurn: number, fromTokens: number, toTokens: number) {
  return { turn: sourceTurn, timestamp: sourceTurn, payload: { sourceTurn, fromTokens, toTokens } };
}

describe("deriveAutoCompactionIneffectiveFromReceipts", () => {
  test("is ineffective when the recent committed reductions stay below the floor", () => {
    expect(
      deriveAutoCompactionIneffectiveFromReceipts(
        [receipt(1, 10_000, 9_600), receipt(2, 10_000, 9_500)],
        0.1,
        1,
      ),
    ).toBe(true);
  });

  test("is fresh when the newest reduction clears the floor", () => {
    expect(
      deriveAutoCompactionIneffectiveFromReceipts(
        [receipt(1, 10_000, 9_500), receipt(3, 10_000, 6_000)],
        0.1,
        1,
      ),
    ).toBe(false);
  });

  test("is never ineffective with no committed receipts", () => {
    expect(deriveAutoCompactionIneffectiveFromReceipts([], 0.1, 1)).toBe(false);
  });

  test("orders newest-first by turn regardless of input order", () => {
    expect(
      deriveAutoCompactionIneffectiveFromReceipts(
        [receipt(2, 10_000, 9_500), receipt(1, 10_000, 9_600)],
        0.1,
        1,
      ),
    ).toBe(true);
  });
});
