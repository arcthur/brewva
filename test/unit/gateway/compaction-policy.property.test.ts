import { expect } from "bun:test";
import { decideCompaction } from "@brewva/brewva-substrate/context-budget";
import type { ContextCompactionGateStatus, ContextStatus } from "@brewva/brewva-vocabulary/context";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

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

propertyTest("eligible auto and model-downshift callers share pressure decisions", {
  propertyId: "gateway.compaction-policy.caller-equivalence",
  layer: "unit",
  arbitraries: [
    fc.record({
      forcedCompaction: fc.boolean(),
      predictedOverflow: fc.boolean(),
      compactionAdvised: fc.boolean(),
      recentCompaction: fc.boolean(),
      pendingReason: fc.option(
        fc.constantFrom("hard_limit", "predicted_overflow", "usage_threshold" as const),
        { nil: null },
      ),
    }),
  ],
  predicate(input) {
    const gateStatus = gate(
      {
        forcedCompaction: input.forcedCompaction,
        predictedOverflow: input.predictedOverflow,
        compactionAdvised: input.compactionAdvised,
      },
      input.recentCompaction,
    );
    const auto = decideCompaction({
      caller: "auto",
      gateStatus,
      pendingReason: input.pendingReason,
      hasUI: true,
      idle: true,
      recoveryPosture: "idle",
    });
    const downshift = decideCompaction({
      caller: "model_downshift",
      gateStatus,
      pendingReason: input.pendingReason,
      currentContextWindow: 200_000,
      targetContextWindow: 64_000,
      usageKnown: true,
    });

    expect({ ...auto, caller: "shared" }).toEqual({ ...downshift, caller: "shared" });
  },
});
