import { describe, expect, test } from "bun:test";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-vocabulary/context";
import { formatContextLedgerLine } from "../../../packages/brewva-cli/src/operator/inspect/context-cockpit.js";

const baseStatus: ContextStatus = {
  tokensUsed: null,
  tokensTotal: 200_000,
  effectiveTokensTotal: 200_000,
  tokensRemaining: null,
  autoCompactLimitTokens: 170_000,
  controllableBaselineTokens: 0,
  controllableTokensUsed: null,
  controllableTokensTotal: 200_000,
  controllableTokensRemaining: null,
  controllableContextRemainingRatio: null,
  tokensUntilForcedCompact: null,
  predictedTurnGrowthTokens: 0,
  tokensUntilPredictedOverflow: null,
  predictedOverflow: false,
  usageRatio: null,
  hardLimitRatio: 0.92,
  compactionThresholdRatio: 0.85,
  compactionAdvised: false,
  forcedCompaction: false,
};

function gate(status: Partial<ContextStatus>): ContextCompactionGateStatus {
  return {
    required: status.forcedCompaction === true,
    reason: status.forcedCompaction
      ? "hard_limit"
      : status.compactionAdvised
        ? "usage_threshold"
        : null,
    status: { ...baseStatus, ...status },
    recentCompaction: false,
    windowTurns: 2,
    lastCompactionTurn: null,
    turnsSinceCompaction: null,
  };
}

describe("formatContextLedgerLine", () => {
  test("renders the derivation chain from the gate's own status (ledger == policy input)", () => {
    const line = formatContextLedgerLine({
      gate: gate({ tokensUsed: 160_000, usageRatio: 0.8, compactionAdvised: true }),
      pendingReason: null,
      lastCompactId: "compact-1",
      cacheStatus: "warm",
    });

    expect(line).toContain("Context ledger:");
    expect(line).toContain("window=200000");
    expect(line).toContain("advisory=170000(0.85)");
    expect(line).toContain("hard=200000(0.92)");
    expect(line).toContain("growth=0");
    expect(line).toContain("usage=160000(0.80)");
    expect(line).toContain("pressure=advised");
    expect(line).toContain("gate=open:usage_threshold");
    expect(line).toContain("lastReceipt=compact-1");
    expect(line).toContain("cache=warm");
  });

  test("marks the gate armed and pressure forced under hard-limit pressure", () => {
    const line = formatContextLedgerLine({
      gate: gate({ forcedCompaction: true, tokensUsed: 190_000, usageRatio: 0.95 }),
      pendingReason: null,
      lastCompactId: null,
      cacheStatus: "reset",
    });

    expect(line).toContain("pressure=forced");
    expect(line).toContain("gate=armed:hard_limit");
    expect(line).toContain("lastReceipt=none");
    expect(line).toContain("cache=reset");
  });

  test("falls back to the pending reason and renders unknown usage as n/a", () => {
    const line = formatContextLedgerLine({
      gate: gate({}),
      pendingReason: "predicted_overflow",
      lastCompactId: null,
      cacheStatus: "unknown",
    });

    expect(line).toContain("usage=n/a(n/a)");
    expect(line).toContain("pressure=ok");
    expect(line).toContain("gate=open:predicted_overflow");
  });
});
