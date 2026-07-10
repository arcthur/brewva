import { describe, expect, test } from "bun:test";
import {
  compactionBreakEvenReads,
  computeNetReuseValue,
} from "@brewva/brewva-substrate/context-budget";

// Golden values cross-check against headroom's published #856 figures:
// Anthropic-shaped multipliers w=1.25 (cache write), r=0.1 (cache read).
const W = 1.25;
const R = 0.1;

describe("computeNetReuseValue", () => {
  test("large shave under a small invalidated suffix is profitable (positive)", () => {
    const estimate = computeNetReuseValue({
      deltaTokens: 50_000,
      suffixTokens: 10_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    // 50000*(1.25+0.1*9) - 1*(1.15)*(60000) = 107500 - 69000 = 38500
    expect(estimate?.netReuseValue).toBeCloseTo(38_500, 6);
  });

  test("small shave under a large warm suffix is wasteful (headroom golden -55500)", () => {
    const estimate = computeNetReuseValue({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(estimate?.netReuseValue).toBeCloseTo(-55_500, 6);
  });

  test("idle past TTL (pAlive=0) drops the penalty term so any positive shave pays", () => {
    const estimate = computeNetReuseValue({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 0,
    });
    // 2000*2.15 - 0 = 4300
    expect(estimate?.netReuseValue).toBeCloseTo(4_300, 6);
  });

  test("pAlive is clamped into [0,1]", () => {
    const clampedHigh = computeNetReuseValue({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 5,
    });
    const atOne = computeNetReuseValue({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(clampedHigh?.netReuseValue).toBeCloseTo(atOne?.netReuseValue ?? Number.NaN, 6);
  });

  test("echoes the resolved inputs for auditability", () => {
    const estimate = computeNetReuseValue({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(estimate?.inputs).toEqual({
      deltaTokens: 2_000,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
  });

  test("an observed expansion (deltaTokens < 0) prices as maximally wasteful, not null", () => {
    // Live calibration golden (session 1de74ac4): a 103-token context compacted
    // INTO a 292-token summary — dT = -189, S = 292. Every future turn pays for
    // the grown context AND the cut still invalidated the cache prefix:
    // -189*(1.25 + 0.1*9) - 1*1.15*(292-189) = -406.35 - 118.45 = -524.8
    const estimate = computeNetReuseValue({
      deltaTokens: -189,
      suffixTokens: 292,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(estimate?.netReuseValue).toBeCloseTo(-524.8, 6);
    expect(estimate?.inputs.deltaTokens).toBe(-189);
  });

  test("an expansion stays negative even when the cache was already dead (pAlive=0)", () => {
    // Dropping the rebuild penalty never turns growth into profit:
    // -189*2.15 - 0 = -406.35
    const estimate = computeNetReuseValue({
      deltaTokens: -189,
      suffixTokens: 292,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 0,
    });
    expect(estimate?.netReuseValue).toBeCloseTo(-406.35, 6);
  });

  test("a cut that freed nothing (deltaTokens = 0) prices the pure cache break", () => {
    // 0 - 1*1.15*50000 = -57500: the prefix was invalidated for zero benefit.
    const estimate = computeNetReuseValue({
      deltaTokens: 0,
      suffixTokens: 50_000,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(estimate?.netReuseValue).toBeCloseTo(-57_500, 6);
  });

  test("an empty no-op cut (deltaTokens = 0, suffix = 0) is exactly zero", () => {
    const estimate = computeNetReuseValue({
      deltaTokens: 0,
      suffixTokens: 0,
      writeMultiplier: W,
      readMultiplier: R,
      expectedReads: 10,
      pAlive: 1,
    });
    expect(estimate?.netReuseValue).toBe(0);
  });

  test("returns null when a pricing multiplier is missing or non-finite", () => {
    expect(
      computeNetReuseValue({
        deltaTokens: 2_000,
        suffixTokens: 50_000,
        writeMultiplier: Number.NaN,
        readMultiplier: R,
        expectedReads: 10,
        pAlive: 1,
      }),
    ).toBeNull();
  });

  test("returns null when the invalidated suffix is negative", () => {
    expect(
      computeNetReuseValue({
        deltaTokens: 2_000,
        suffixTokens: -1,
        writeMultiplier: W,
        readMultiplier: R,
        expectedReads: 10,
        pAlive: 1,
      }),
    ).toBeNull();
  });

  test("returns null when write does not exceed read (rebuild penalty non-positive)", () => {
    // w == r: penalty term (w-r) = 0 → fake zero-cost cut.
    expect(
      computeNetReuseValue({
        deltaTokens: 2_000,
        suffixTokens: 50_000,
        writeMultiplier: 0.1,
        readMultiplier: 0.1,
        expectedReads: 10,
        pAlive: 1,
      }),
    ).toBeNull();
    // w < r: penalty term negative → fabricated positive gain.
    expect(
      computeNetReuseValue({
        deltaTokens: 2_000,
        suffixTokens: 50_000,
        writeMultiplier: 0.05,
        readMultiplier: 0.1,
        expectedReads: 10,
        pAlive: 1,
      }),
    ).toBeNull();
  });
});

describe("compactionBreakEvenReads", () => {
  test("R = ((w-r)/r)*(S/dT) — 2K shave under 50K suffix needs ~287.5 reads", () => {
    const reads = compactionBreakEvenReads({
      writeMultiplier: W,
      readMultiplier: R,
      suffixTokens: 50_000,
      deltaTokens: 2_000,
    });
    expect(reads).toBeCloseTo(287.5, 6);
  });

  test("a 50K shave under a 10K suffix breaks even at ~2.3 reads", () => {
    const reads = compactionBreakEvenReads({
      writeMultiplier: W,
      readMultiplier: R,
      suffixTokens: 10_000,
      deltaTokens: 50_000,
    });
    expect(reads).toBeCloseTo(2.3, 6);
  });

  test("returns null when the read multiplier is zero (division undefined)", () => {
    expect(
      compactionBreakEvenReads({
        writeMultiplier: W,
        readMultiplier: 0,
        suffixTokens: 10_000,
        deltaTokens: 50_000,
      }),
    ).toBeNull();
  });

  test("returns null when write does not exceed read (no positive break-even)", () => {
    expect(
      compactionBreakEvenReads({
        writeMultiplier: 0.1,
        readMultiplier: 0.1,
        suffixTokens: 10_000,
        deltaTokens: 50_000,
      }),
    ).toBeNull();
  });

  test("returns null when no tokens were freed", () => {
    expect(
      compactionBreakEvenReads({
        writeMultiplier: W,
        readMultiplier: R,
        suffixTokens: 10_000,
        deltaTokens: 0,
      }),
    ).toBeNull();
  });

  test("returns null for an expansion — no finite read count redeems it", () => {
    // Unlike computeNetReuseValue (which prices dT < 0 as a loss), break-even
    // genuinely does not exist here: the net value is negative for every R.
    expect(
      compactionBreakEvenReads({
        writeMultiplier: W,
        readMultiplier: R,
        suffixTokens: 292,
        deltaTokens: -189,
      }),
    ).toBeNull();
  });
});
