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

  test("is order-independent: the newest-first fold ignores input order", () => {
    // Same receipts (turn 1 ineffective at 4%, turn 3 fresh at 40%) in BOTH input orders must
    // give the same verdict, because the fold sorts newest-first before applying the floor.
    // A dropped or reversed sort makes the oldest-first case read turn 1 first and flip to
    // `true` — the discriminating case the old same-order, both-ineffective input never had.
    const oldestFirst = [receipt(1, 10_000, 9_600), receipt(3, 10_000, 6_000)];
    const newestFirst = [receipt(3, 10_000, 6_000), receipt(1, 10_000, 9_600)];
    expect(deriveAutoCompactionIneffectiveFromReceipts(oldestFirst, 0.1, 1)).toBe(false);
    expect(deriveAutoCompactionIneffectiveFromReceipts(newestFirst, 0.1, 1)).toBe(false);
  });
});
