import { describe, expect, test } from "bun:test";
import { resolveCacheCostMultipliers } from "@brewva/brewva-provider-core";

describe("resolveCacheCostMultipliers", () => {
  test("derives write/read multipliers relative to base input price", () => {
    // Anthropic Haiku-shaped: input=1, cacheWrite=1.25, cacheRead=0.1.
    expect(resolveCacheCostMultipliers({ input: 1, cacheRead: 0.1, cacheWrite: 1.25 })).toEqual({
      writeMultiplier: 1.25,
      readMultiplier: 0.1,
    });
  });

  test("multipliers are relative, so a higher base input price yields the same ratios", () => {
    // input=3 with proportional cache costs gives identical multipliers.
    const result = resolveCacheCostMultipliers({ input: 3, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(result?.writeMultiplier).toBeCloseTo(1.25, 6);
    expect(result?.readMultiplier).toBeCloseTo(0.1, 6);
  });

  test("returns null when the base input price is zero (division undefined)", () => {
    expect(resolveCacheCostMultipliers({ input: 0, cacheRead: 0.1, cacheWrite: 1.25 })).toBeNull();
  });

  test("returns null when a price is non-finite", () => {
    expect(
      resolveCacheCostMultipliers({ input: 1, cacheRead: Number.NaN, cacheWrite: 1.25 }),
    ).toBeNull();
  });

  test("returns null for negative cache costs (invalid pricing, fail closed)", () => {
    expect(resolveCacheCostMultipliers({ input: 1, cacheRead: -0.1, cacheWrite: 1.25 })).toBeNull();
    expect(resolveCacheCostMultipliers({ input: 1, cacheRead: 0.1, cacheWrite: -1.25 })).toBeNull();
  });
});
