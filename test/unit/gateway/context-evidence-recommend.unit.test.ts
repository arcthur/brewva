import { describe, expect, test } from "bun:test";
import { deriveContextEvidenceRecommendation } from "@brewva/brewva-gateway/hosted";

const ratios = { advisoryRatio: 0.82, hardRatio: 0.94, tailProtectRatio: 0.2 };

describe("deriveContextEvidenceRecommendation", () => {
  test("reports insufficient evidence below the sample-size floor", () => {
    const out = deriveContextEvidenceRecommendation({ warm: 2, reset: 1, ...ratios });
    expect(out.posture).toBe("insufficient_evidence");
    expect(out.sampleSize).toBe(3);
    expect(out.observedCacheResetRatio).toBeCloseTo(1 / 3, 5);
  });

  test("holds when post-compaction cache stays warm", () => {
    const out = deriveContextEvidenceRecommendation({ warm: 18, reset: 2, ...ratios });
    expect(out.posture).toBe("hold");
    expect(out.sampleSize).toBe(20);
    expect(out.observedCacheResetRatio).toBeCloseTo(0.1, 5);
  });

  test("recommends review when compaction resets the cache too often", () => {
    const out = deriveContextEvidenceRecommendation({ warm: 4, reset: 16, ...ratios });
    expect(out.posture).toBe("review");
    expect(out.observedCacheResetRatio).toBeCloseTo(0.8, 5);
  });

  test("echoes the current config ratios so the recommendation is diffable", () => {
    const out = deriveContextEvidenceRecommendation({ warm: 18, reset: 2, ...ratios });
    expect(out.currentAdvisoryRatio).toBe(0.82);
    expect(out.currentHardRatio).toBe(0.94);
    expect(out.currentTailProtectRatio).toBe(0.2);
    expect(out.schema).toBe("brewva.context-evidence.recommendation.v1");
  });

  test("treats an empty sample as insufficient with a null ratio", () => {
    const out = deriveContextEvidenceRecommendation({ warm: 0, reset: 0, ...ratios });
    expect(out.posture).toBe("insufficient_evidence");
    expect(out.observedCacheResetRatio).toBeNull();
  });
});
