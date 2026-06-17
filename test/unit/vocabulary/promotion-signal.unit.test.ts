import { describe, expect, test } from "bun:test";
import { collectRetentionPromotionSignals } from "@brewva/brewva-vocabulary/iteration";

describe("retention promotion signal (pure selection)", () => {
  test("nominates a note the model marked with a promotion-eligible retentionHint", () => {
    const signals = collectRetentionPromotionSignals(
      [
        {
          id: "n1",
          kind: "note",
          digest: "d1",
          reason: "salient",
          sourceRefs: ["file:a"],
          retentionHint: "attention_pin",
        },
        { id: "n2", kind: "note", digest: "d2", reason: "noise", sourceRefs: [] },
      ],
      [],
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      entryId: "n1",
      reason: "retention_hint",
      retentionHint: "attention_pin",
    });
  });

  test("does not nominate arbitrary retention hints by default", () => {
    const signals = collectRetentionPromotionSignals(
      [
        {
          id: "n1",
          kind: "note",
          digest: "d1",
          reason: "temporary",
          sourceRefs: ["turn:1"],
          retentionHint: "session",
        },
      ],
      [],
    );

    expect(signals).toHaveLength(0);
  });

  test("allows callers to opt in additional promotion-eligible retention hints", () => {
    const signals = collectRetentionPromotionSignals(
      [
        {
          id: "n1",
          kind: "note",
          digest: "d1",
          reason: "temporary",
          sourceRefs: ["turn:1"],
          retentionHint: "session",
        },
      ],
      [],
      { promotionEligibleRetentionHints: ["session"] },
    );

    expect(signals).toEqual([
      {
        entryId: "n1",
        reason: "retention_hint",
        retentionHint: "session",
        consumeCount: 0,
        digest: "d1",
        sourceRefs: ["turn:1"],
      },
    ]);
  });

  test("nominates a note consumed at least minConsumeCount times", () => {
    const signals = collectRetentionPromotionSignals(
      [{ id: "n1", kind: "note", digest: "d1", reason: "salient", sourceRefs: [] }],
      [{ entryId: "n1", consumeCount: 3 }],
      { minConsumeCount: 3 },
    );

    expect(signals[0]).toMatchObject({
      entryId: "n1",
      reason: "repeated_consumption",
      consumeCount: 3,
    });
  });

  test("skips evictions and notes below the consume threshold", () => {
    const signals = collectRetentionPromotionSignals(
      [
        { id: "e1", kind: "eviction", digest: "d", reason: "stale", sourceRefs: [] },
        { id: "n1", kind: "note", digest: "d", reason: "salient", sourceRefs: [] },
      ],
      [{ entryId: "n1", consumeCount: 1 }],
      { minConsumeCount: 3 },
    );

    expect(signals).toHaveLength(0);
  });
});
