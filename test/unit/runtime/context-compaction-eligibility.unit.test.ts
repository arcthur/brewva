import { describe, expect, test } from "bun:test";
import {
  resolveContextCompactionEligibility,
  type ContextCompactionEligibilityInput,
} from "../../../packages/brewva-runtime/src/domain/context/eligibility.js";
import type {
  ContextCompactionReason,
  ContextStatus,
} from "../../../packages/brewva-runtime/src/domain/context/types.js";

function status(overrides: Partial<ContextStatus> = {}): ContextStatus {
  return {
    tokensUsed: 0,
    tokensTotal: 1000,
    effectiveTokensTotal: 1000,
    tokensRemaining: 1000,
    autoCompactLimitTokens: 800,
    controllableBaselineTokens: 0,
    controllableTokensUsed: 0,
    controllableTokensTotal: 1000,
    controllableTokensRemaining: 1000,
    controllableContextRemainingRatio: 1,
    tokensUntilForcedCompact: 900,
    predictedTurnGrowthTokens: 0,
    tokensUntilPredictedOverflow: 900,
    predictedOverflow: false,
    usageRatio: 0,
    hardLimitRatio: 0.9,
    compactionThresholdRatio: 0.8,
    compactionAdvised: false,
    forcedCompaction: false,
    ...overrides,
  };
}

function input(
  overrides: Partial<ContextCompactionEligibilityInput> = {},
): ContextCompactionEligibilityInput {
  return {
    enabled: true,
    status: status(),
    pendingReason: null,
    recentCompaction: false,
    hasUI: true,
    idle: true,
    recoveryPosture: "idle",
    autoCompactionInFlight: false,
    autoCompactionBreakerOpen: false,
    gateMode: "hosted_auto",
    ...overrides,
  };
}

describe("context compaction eligibility", () => {
  test("skips when context budget is disabled or there is no pressure request", () => {
    expect(resolveContextCompactionEligibility(input({ enabled: false }))).toEqual({
      decision: "skip",
      reason: "no_request",
    });
    expect(resolveContextCompactionEligibility(input())).toEqual({
      decision: "skip",
      reason: "no_request",
    });
  });

  test("returns advisory execution reasons from the shared status projection", () => {
    expect(
      resolveContextCompactionEligibility(
        input({
          status: status({ compactionAdvised: true, usageRatio: 0.82 }),
        }),
      ),
    ).toEqual({
      decision: "execute",
      reason: "usage_threshold" satisfies ContextCompactionReason,
    });
    expect(
      resolveContextCompactionEligibility(
        input({
          status: status({
            predictedOverflow: true,
            tokensUntilPredictedOverflow: 0,
            usageRatio: 0.7,
          }),
        }),
      ),
    ).toEqual({
      decision: "execute",
      reason: "predicted_overflow" satisfies ContextCompactionReason,
    });
  });

  test("blocks tool-gate callers at hard pressure while hosted auto-compaction can execute", () => {
    const hardStatus = status({
      compactionAdvised: true,
      forcedCompaction: true,
      usageRatio: 0.95,
      tokensUntilForcedCompact: 0,
    });

    expect(
      resolveContextCompactionEligibility(input({ gateMode: "tool_gate", status: hardStatus })),
    ).toEqual({
      decision: "gate_blocked",
      reason: "hard_limit",
    });
    expect(resolveContextCompactionEligibility(input({ status: hardStatus }))).toEqual({
      decision: "execute",
      reason: "hard_limit" satisfies ContextCompactionReason,
    });
  });

  test("applies hosted operational guards after pressure is present", () => {
    const pressured = status({ compactionAdvised: true, usageRatio: 0.82 });

    expect(
      resolveContextCompactionEligibility(input({ status: pressured, recoveryPosture: "active" })),
    ).toEqual({
      decision: "skip",
      reason: "recovery_active",
    });
    expect(resolveContextCompactionEligibility(input({ status: pressured, hasUI: false }))).toEqual(
      {
        decision: "skip",
        reason: "non_interactive_mode",
      },
    );
    expect(resolveContextCompactionEligibility(input({ status: pressured, idle: false }))).toEqual({
      decision: "skip",
      reason: "agent_active_manual_compaction_unsafe",
    });
    expect(
      resolveContextCompactionEligibility(
        input({ status: pressured, autoCompactionBreakerOpen: true }),
      ),
    ).toEqual({
      decision: "skip",
      reason: "auto_compaction_breaker_open",
    });
    expect(
      resolveContextCompactionEligibility(
        input({ status: pressured, autoCompactionInFlight: true }),
      ),
    ).toEqual({
      decision: "skip",
      reason: "auto_compaction_in_flight",
    });
  });

  test("honors explicit pending reasons and turn cooldown", () => {
    expect(
      resolveContextCompactionEligibility(
        input({
          pendingReason: "hard_limit",
          status: status({ usageRatio: 0.2 }),
        }),
      ),
    ).toEqual({
      decision: "execute",
      reason: "hard_limit" satisfies ContextCompactionReason,
    });
    expect(
      resolveContextCompactionEligibility(
        input({
          recentCompaction: true,
          status: status({ compactionAdvised: true, usageRatio: 0.82 }),
        }),
      ),
    ).toEqual({
      decision: "skip",
      reason: "recent_compaction",
    });
  });
});
