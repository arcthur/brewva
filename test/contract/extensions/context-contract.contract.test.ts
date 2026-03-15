import { describe, expect, test } from "bun:test";
import { applyContextContract } from "@brewva/brewva-gateway/runtime-plugins";

describe("context contract", () => {
  test("refreshes dynamic thresholds when an existing contract block is present", () => {
    const runtime = {
      context: {
        getCompactionThresholdRatio(_sessionId: string, usage?: { percent?: number | null }) {
          return usage?.percent === 0.5 ? 0.82 : 0.9;
        },
        getHardLimitRatio(_sessionId: string, usage?: { percent?: number | null }) {
          return usage?.percent === 0.5 ? 0.94 : 0.97;
        },
      },
    };

    const first = applyContextContract("base prompt", runtime as never, "contract-1", {
      tokens: 500,
      contextWindow: 1000,
      percent: 0.5,
    });
    const refreshed = applyContextContract(first, runtime as never, "contract-1", {
      tokens: 900000,
      contextWindow: 1000000,
      percent: 0.9,
    });

    expect(refreshed).toContain("compact soon when context pressure reaches high (90%)");
    expect(refreshed).toContain("compact immediately when context pressure becomes critical (97%)");
    expect(refreshed).not.toContain("82%");
    expect(refreshed).not.toContain("94%");
    expect(refreshed.match(/\[Brewva Context Contract\]/g)?.length).toBe(1);
  });
});
