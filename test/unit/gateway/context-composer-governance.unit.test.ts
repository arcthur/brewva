import { describe, expect, test } from "bun:test";
import {
  applyGovernanceBudgetCap,
  type GovernanceContextBlock,
  type GovernanceContextMetrics,
} from "../../../packages/brewva-gateway/src/runtime-plugins/context-composer-governance.js";

function buildMetrics(blocks: GovernanceContextBlock[]): GovernanceContextMetrics {
  let narrativeTokens = 0;
  let constraintTokens = 0;
  let diagnosticTokens = 0;
  for (const block of blocks) {
    if (block.category === "narrative") {
      narrativeTokens += block.estimatedTokens;
      continue;
    }
    if (block.category === "constraint") {
      constraintTokens += block.estimatedTokens;
      continue;
    }
    diagnosticTokens += block.estimatedTokens;
  }
  const totalTokens = narrativeTokens + constraintTokens + diagnosticTokens;
  return {
    totalTokens,
    narrativeTokens,
    constraintTokens,
    diagnosticTokens,
    narrativeRatio: totalTokens > 0 ? narrativeTokens / totalTokens : 0,
  };
}

describe("context composer governance", () => {
  test("drops diagnostics before inventory and preserves compaction advisory when over cap", () => {
    const blocks: GovernanceContextBlock[] = [
      {
        id: "source:narrative:1",
        category: "narrative",
        content: "narrative",
        estimatedTokens: 200,
      },
      {
        id: "diagnostic-extra",
        category: "diagnostic",
        content: "diag",
        estimatedTokens: 20,
      },
      {
        id: "capability-view-inventory",
        category: "constraint",
        content: "inventory",
        estimatedTokens: 40,
      },
      {
        id: "compaction-advisory",
        category: "constraint",
        content: "advisory",
        estimatedTokens: 40,
      },
      {
        id: "capability-view-policy",
        category: "constraint",
        content: "policy",
        estimatedTokens: 80,
      },
    ];

    const result = applyGovernanceBudgetCap(blocks, buildMetrics);
    const resultIds = result.map((block) => block.id);

    expect(resultIds).not.toContain("diagnostic-extra");
    expect(resultIds).not.toContain("capability-view-inventory");
    expect(resultIds).toContain("compaction-advisory");
    expect(resultIds).toContain("capability-view-policy");
  });
});
