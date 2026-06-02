import { describe, expect, test } from "bun:test";
import { decideCompaction } from "@brewva/brewva-substrate/context-budget";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-vocabulary/context";

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

function gate(
  status: Partial<ContextStatus>,
  recentCompaction = false,
): ContextCompactionGateStatus {
  return {
    required: status.forcedCompaction === true,
    reason: status.forcedCompaction
      ? "hard_limit"
      : status.predictedOverflow
        ? "predicted_overflow"
        : status.compactionAdvised
          ? "usage_threshold"
          : null,
    status: { ...baseStatus, ...status },
    recentCompaction,
    windowTurns: 4,
    lastCompactionTurn: recentCompaction ? 10 : null,
    turnsSinceCompaction: recentCompaction ? 1 : null,
  };
}

describe("decideCompaction", () => {
  test("manual compaction always executes through the shared policy", () => {
    expect(
      decideCompaction({
        caller: "manual",
        gateStatus: gate({}),
      }),
    ).toEqual({ decision: "execute", caller: "manual", reason: "manual" });
  });

  test("auto compaction executes only after pressure and hosted eligibility are present", () => {
    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: gate({ compactionAdvised: true }),
        hasUI: true,
        idle: true,
        recoveryPosture: "idle",
      }),
    ).toEqual({ decision: "execute", caller: "auto", reason: "usage_threshold" });

    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: gate({ compactionAdvised: true }),
        hasUI: true,
        idle: false,
        recoveryPosture: "idle",
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "agent_active_manual_compaction_unsafe",
    });

    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: gate({ compactionAdvised: true }),
        hasUI: true,
        idle: true,
        recoveryPosture: "idle",
        autoCompactionBreakerOpen: true,
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "auto_compaction_breaker_open",
    });
  });

  test("model downshift uses the same pressure decision over the target window", () => {
    expect(
      decideCompaction({
        caller: "model_downshift",
        gateStatus: gate({ predictedOverflow: true }),
        currentContextWindow: 200_000,
        targetContextWindow: 64_000,
        usageKnown: true,
      }),
    ).toEqual({ decision: "execute", caller: "model_downshift", reason: "predicted_overflow" });

    expect(
      decideCompaction({
        caller: "model_downshift",
        gateStatus: gate({ predictedOverflow: true }),
        currentContextWindow: 64_000,
        targetContextWindow: 200_000,
        usageKnown: true,
      }),
    ).toEqual({
      decision: "skip",
      caller: "model_downshift",
      reason: "target_context_not_smaller",
    });
  });
});
