// Compaction economics: a pure, Brewva-native adaptation of headroom's #856
// net-cost model. This is evidence physics, not a runtime decision — nothing in
// the kernel commitment path consumes it. See
// `docs/research/active/rfc-quantified-compaction-economics-and-evidence-honesty.md`.

import { clamp01 } from "@brewva/brewva-std/math";

export interface NetReuseInputs {
  // Tokens freed by the compaction cut (fromTokens - toTokens). Negative when
  // the cut GREW the retained context (the summary outweighed what it replaced)
  // — an observed outcome that prices as a loss, never as missing data.
  deltaTokens: number;
  // Provider input tokens in the cache suffix the cut invalidates (S).
  suffixTokens: number;
  // Provider cache WRITE / READ price multipliers relative to base input price.
  writeMultiplier: number;
  readMultiplier: number;
  // Expected remaining reads of the suffix before TTL lapse (R).
  expectedReads: number;
  // Probability the cache survives to the next turn, in [0, 1].
  pAlive: number;
}

export interface NetReuseEstimate {
  netReuseValue: number;
  inputs: NetReuseInputs;
}

/**
 * netReuseValue = dT*(w + r*(R-1)) - pAlive*(w-r)*(S+dT)
 *
 * Positive means the cut freed more cache value than it cost to rebuild the
 * invalidated suffix. dT <= 0 — a cut that freed nothing, or a summary that
 * grew the context — is an observed outcome, not missing data: both terms then
 * point the same way, so the value is non-positive and can never fabricate a
 * profit. Returns null only when an input is missing or degenerate, so absent
 * pricing/suffix data never fabricates a number.
 */
export function computeNetReuseValue(input: NetReuseInputs): NetReuseEstimate | null {
  const { deltaTokens, suffixTokens, writeMultiplier, readMultiplier, expectedReads } = input;
  if (
    !Number.isFinite(deltaTokens) ||
    !Number.isFinite(suffixTokens) ||
    !Number.isFinite(writeMultiplier) ||
    !Number.isFinite(readMultiplier) ||
    !Number.isFinite(expectedReads) ||
    !Number.isFinite(input.pAlive)
  ) {
    return null;
  }
  if (
    suffixTokens < 0 ||
    writeMultiplier <= 0 ||
    readMultiplier < 0 ||
    // Write must cost strictly more than read, or the rebuild penalty (w-r) goes
    // non-positive and fabricates a positive net value. Fail closed.
    writeMultiplier <= readMultiplier ||
    expectedReads < 1
  ) {
    return null;
  }
  const pAlive = clamp01(input.pAlive);
  const reuseGain = deltaTokens * (writeMultiplier + readMultiplier * (expectedReads - 1));
  const rebuildPenalty = pAlive * (writeMultiplier - readMultiplier) * (suffixTokens + deltaTokens);
  return {
    netReuseValue: reuseGain - rebuildPenalty,
    inputs: { deltaTokens, suffixTokens, writeMultiplier, readMultiplier, expectedReads, pAlive },
  };
}

/**
 * Break-even reads: solving netReuseValue = 0 at pAlive = 1 for R gives
 * R = ((w - r) / r) * (S / dT). Returns null when read pricing is absent, write
 * does not exceed read, or dT <= 0 — unlike computeNetReuseValue (which prices
 * an expansion as a loss), no finite read count exists that redeems it.
 */
export function compactionBreakEvenReads(input: {
  writeMultiplier: number;
  readMultiplier: number;
  suffixTokens: number;
  deltaTokens: number;
}): number | null {
  const { writeMultiplier, readMultiplier, suffixTokens, deltaTokens } = input;
  if (
    !Number.isFinite(writeMultiplier) ||
    !Number.isFinite(readMultiplier) ||
    !Number.isFinite(suffixTokens) ||
    !Number.isFinite(deltaTokens)
  ) {
    return null;
  }
  if (
    readMultiplier <= 0 ||
    deltaTokens <= 0 ||
    writeMultiplier - readMultiplier <= 0 ||
    suffixTokens < 0
  ) {
    return null;
  }
  return ((writeMultiplier - readMultiplier) / readMultiplier) * (suffixTokens / deltaTokens);
}
