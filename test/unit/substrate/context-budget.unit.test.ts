import { describe, expect, test } from "bun:test";
import {
  decideCompaction,
  deriveContextBudgetState,
  readAutoCompactionBreakerOpen,
  readAutoCompactionIneffective,
  resolveWindowScaledTokens,
} from "@brewva/brewva-substrate/context-budget";
import type { ContextBudgetUsage } from "@brewva/brewva-vocabulary/context";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

const baseConfig = {
  enabled: true,
  thresholds: {
    hardRatio: 0.9,
    advisoryRatio: 0.75,
    headroomTokens: 1_000,
  },
  predictedTurnGrowthTokens: 500,
  compaction: {
    minTurnsBetween: 2,
  },
};

function usage(tokens: number | null, contextWindow = 10_000): ContextBudgetUsage {
  return {
    tokens,
    contextWindow,
    percent: tokens === null ? null : (tokens / contextWindow) * 100,
    maxOutputTokens: 1_000,
  };
}

describe("deriveContextBudgetState", () => {
  test("derives below-advisory, advisory, predicted-overflow, hard-limit, and unknown states", () => {
    expect(
      deriveContextBudgetState({
        usage: usage(6_000),
        config: baseConfig,
      }).status,
    ).toMatchObject({
      compactionAdvised: false,
      forcedCompaction: false,
      predictedOverflow: false,
      autoCompactLimitTokens: 7_500,
      tokensUntilForcedCompact: 3_000,
    });

    expect(
      deriveContextBudgetState({
        usage: usage(7_500),
        config: baseConfig,
      }).status,
    ).toMatchObject({
      compactionAdvised: true,
      forcedCompaction: false,
      predictedOverflow: false,
      tokensUntilForcedCompact: 1_500,
    });

    expect(
      deriveContextBudgetState({
        usage: usage(8_700),
        config: baseConfig,
      }),
    ).toMatchObject({
      pendingReason: "predicted_overflow",
      gateStatus: {
        required: false,
        reason: "predicted_overflow",
      },
      status: {
        compactionAdvised: true,
        forcedCompaction: false,
        predictedOverflow: true,
        tokensUntilPredictedOverflow: 0,
      },
    });

    expect(
      deriveContextBudgetState({
        usage: usage(9_000),
        config: baseConfig,
      }),
    ).toMatchObject({
      pendingReason: "hard_limit",
      gateStatus: {
        required: true,
        reason: "hard_limit",
      },
      status: {
        compactionAdvised: true,
        forcedCompaction: true,
        predictedOverflow: true,
        tokensUntilForcedCompact: 0,
      },
    });

    expect(
      deriveContextBudgetState({
        usage: usage(null),
        config: baseConfig,
      }),
    ).toMatchObject({
      pendingReason: null,
      status: {
        tokensUsed: null,
        usageRatio: null,
        compactionAdvised: false,
        forcedCompaction: false,
        predictedOverflow: false,
      },
      gateStatus: {
        required: false,
        reason: null,
      },
    });
  });

  test("does not arm pressure when context budget is disabled or the window is unknown", () => {
    expect(
      deriveContextBudgetState({
        usage: usage(9_500),
        config: {
          ...baseConfig,
          enabled: false,
        },
      }),
    ).toMatchObject({
      pendingReason: null,
      effectivePredictedGrowthTokens: 0,
      status: {
        compactionAdvised: false,
        forcedCompaction: false,
        predictedOverflow: false,
      },
      gateStatus: {
        required: false,
        reason: null,
      },
    });

    expect(
      deriveContextBudgetState({
        usage: {
          tokens: 0,
          contextWindow: 0,
          percent: null,
          maxOutputTokens: null,
        },
        config: baseConfig,
      }),
    ).toMatchObject({
      pendingReason: null,
      status: {
        compactionAdvised: false,
        forcedCompaction: false,
        predictedOverflow: false,
      },
      gateStatus: {
        required: false,
        reason: null,
      },
    });
  });

  test("uses the max predicted growth source and clamps it to the target window", () => {
    const derived = deriveContextBudgetState({
      usage: usage(40_000, 64_000),
      config: {
        ...baseConfig,
        predictedTurnGrowthTokens: 2_000,
        thresholds: {
          hardRatio: 0.95,
          advisoryRatio: 0.8,
          headroomTokens: 8_000,
        },
      },
      model: {
        predictedTurnGrowthTokens: 12_000,
      },
      provider: {
        predictedTurnGrowthTokensEma: 20_000,
      },
      request: {
        predictedTurnGrowthTokens: 70_000,
      },
    });

    expect(derived.effectivePredictedGrowthTokens).toBe(64_000);
    expect(derived.status.predictedTurnGrowthTokens).toBe(64_000);
    expect(derived.limits.hardLimitTokens).toBe(56_000);
    expect(derived.status.predictedOverflow).toBe(true);
  });

  test("derives recent-compaction window data without requiring process-local state", () => {
    const derived = deriveContextBudgetState({
      usage: usage(8_000),
      config: baseConfig,
      recentCompaction: {
        currentTurn: 12,
        lastCompactionTurn: 11,
      },
    });

    expect(derived.gateStatus).toMatchObject({
      recentCompaction: true,
      windowTurns: 2,
      lastCompactionTurn: 11,
      turnsSinceCompaction: 1,
    });
  });

  test("window-scaled token budgets prefer absolute overrides and scale by ratio", () => {
    expect(resolveWindowScaledTokens(12_000, 0.2, 100_000)).toBe(12_000);
    expect(resolveWindowScaledTokens(null, 0.2, 100_000)).toBe(20_000);
    expect(resolveWindowScaledTokens(null, 0.2, 1_000_000)).toBe(200_000);
    expect(resolveWindowScaledTokens(null, 1.5, 100_000)).toBe(100_000);
    expect(resolveWindowScaledTokens(null, null, 100_000)).toBeNull();
    expect(resolveWindowScaledTokens(null, 0.2, null)).toBeNull();
  });

  test("predicted growth ratio scales with the context window when no override is set", () => {
    const derived = deriveContextBudgetState({
      usage: usage(6_000),
      config: {
        ...baseConfig,
        predictedTurnGrowthTokens: null,
        predictedTurnGrowthRatio: 0.175,
      },
    });

    expect(derived.effectivePredictedGrowthTokens).toBe(1_750);
  });

  test("auto caller defers to advisory state while the agent is active below hard limit", () => {
    const advisory = deriveContextBudgetState({
      usage: usage(7_500),
      config: baseConfig,
    });

    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: advisory.gateStatus,
        hasUI: true,
        idle: false,
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "agent_active_manual_compaction_unsafe",
    });
  });

  test("auto caller executes under hard-limit pressure even while the agent is active", () => {
    const forced = deriveContextBudgetState({
      usage: usage(9_500),
      config: baseConfig,
    });

    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: forced.gateStatus,
        hasUI: true,
        idle: false,
      }),
    ).toEqual({
      decision: "execute",
      caller: "auto",
      reason: "hard_limit",
    });
  });

  test("model-downshift callers use target-window pressure before switching", () => {
    const state = deriveContextBudgetState({
      usage: usage(55_000, 64_000),
      config: {
        ...baseConfig,
        thresholds: {
          hardRatio: 0.9,
          advisoryRatio: 0.75,
          headroomTokens: 8_000,
        },
        predictedTurnGrowthTokens: 4_000,
      },
    });

    expect(
      decideCompaction({
        caller: "model_downshift",
        gateStatus: state.gateStatus,
        currentContextWindow: 200_000,
        targetContextWindow: 64_000,
        usageKnown: true,
      }),
    ).toEqual({
      decision: "execute",
      caller: "model_downshift",
      reason: "predicted_overflow",
    });
  });
});

describe("decideCompaction headless auto-compaction eval affordance", () => {
  const advisoryGate = () =>
    deriveContextBudgetState({ usage: usage(7_500), config: baseConfig }).gateStatus;

  test("skips non_interactive_mode when hasUI is false and the eval opt-in is absent", () => {
    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: advisoryGate(),
        hasUI: false,
        idle: true,
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "non_interactive_mode",
    });
  });

  test("allowNonInteractive lets the auto path execute headlessly under advisory pressure", () => {
    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: advisoryGate(),
        hasUI: false,
        allowNonInteractive: true,
        idle: true,
      }),
    ).toMatchObject({
      decision: "execute",
      caller: "auto",
    });
  });

  test("allowNonInteractive is narrow: it does not bypass the active-agent safety skip", () => {
    expect(
      decideCompaction({
        caller: "auto",
        gateStatus: advisoryGate(),
        hasUI: false,
        allowNonInteractive: true,
        idle: false,
      }),
    ).toEqual({
      decision: "skip",
      caller: "auto",
      reason: "agent_active_manual_compaction_unsafe",
    });
  });
});

describe("readAutoCompactionBreakerOpen", () => {
  test("opens only after the latest run has consecutive auto failures past the threshold", () => {
    expect(
      readAutoCompactionBreakerOpen([
        { type: "context.compaction.auto.failed", timestamp: 1, id: "a" },
        { type: "context.compaction.auto.failed", timestamp: 2, id: "b" },
      ]),
    ).toBe(false);

    expect(
      readAutoCompactionBreakerOpen([
        { type: "context.compaction.auto.completed", timestamp: 2, id: "completed" },
        { type: "context.compaction.auto.failed", timestamp: 4, id: "c" },
        { type: "context.compaction.auto.failed", timestamp: 3, id: "b" },
        { type: "context.compaction.auto.failed", timestamp: 5, id: "d" },
      ]),
    ).toBe(true);
  });

  test("closes when the newest breaker evidence is auto-completed", () => {
    expect(
      readAutoCompactionBreakerOpen([
        { type: "context.compaction.auto.failed", timestamp: 1, id: "a" },
        { type: "context.compaction.auto.failed", timestamp: 2, id: "b" },
        { type: "context.compaction.auto.failed", timestamp: 3, id: "c" },
        { type: "context.compaction.auto.completed", timestamp: 4, id: "completed" },
      ]),
    ).toBe(false);
  });

  test("uses turn order before event id when breaker evidence shares a timestamp", () => {
    expect(
      readAutoCompactionBreakerOpen([
        { type: "context.compaction.auto.failed", timestamp: 10, turn: 1, id: "z-failed-1" },
        { type: "context.compaction.auto.failed", timestamp: 10, turn: 2, id: "z-failed-2" },
        { type: "context.compaction.auto.failed", timestamp: 10, turn: 3, id: "z-failed-3" },
        { type: "context.compaction.auto.completed", timestamp: 10, turn: 4, id: "a-completed" },
      ]),
    ).toBe(false);
  });
});

describe("readAutoCompactionIneffective", () => {
  test("returns false when fewer than minAttempts usable receipts exist", () => {
    expect(readAutoCompactionIneffective([], 0.1, 1)).toBe(false);
    expect(readAutoCompactionIneffective([{ fromTokens: 1_000, toTokens: 950 }], 0.1, 2)).toBe(
      false,
    );
  });

  test("returns true when the most recent usable reduction stays below the floor", () => {
    expect(readAutoCompactionIneffective([{ fromTokens: 1_000, toTokens: 950 }], 0.1, 1)).toBe(
      true,
    );
  });

  test("resets when the most recent usable reduction clears the floor", () => {
    expect(
      readAutoCompactionIneffective(
        [
          { fromTokens: 1_000, toTokens: 400 },
          { fromTokens: 1_000, toTokens: 980 },
        ],
        0.1,
        1,
      ),
    ).toBe(false);
  });

  test("ignores receipts without a usable fromTokens/toTokens pair", () => {
    expect(
      readAutoCompactionIneffective(
        [
          { fromTokens: null, toTokens: 5 },
          { fromTokens: 0, toTokens: 0 },
          { fromTokens: 1_000, toTokens: 950 },
        ],
        0.1,
        1,
      ),
    ).toBe(true);
  });

  test("requires every one of the most recent minAttempts reductions below the floor", () => {
    expect(
      readAutoCompactionIneffective(
        [
          { fromTokens: 1_000, toTokens: 950 },
          { fromTokens: 1_000, toTokens: 960 },
        ],
        0.1,
        2,
      ),
    ).toBe(true);
    expect(
      readAutoCompactionIneffective(
        [
          { fromTokens: 1_000, toTokens: 950 },
          { fromTokens: 1_000, toTokens: 300 },
        ],
        0.1,
        2,
      ),
    ).toBe(false);
  });

  test("a zero floor disables the guard", () => {
    expect(readAutoCompactionIneffective([{ fromTokens: 1_000, toTokens: 1_000 }], 0, 1)).toBe(
      false,
    );
  });

  test("treats a context that grew (toTokens > fromTokens) as a zero reduction below the floor", () => {
    expect(readAutoCompactionIneffective([{ fromTokens: 1_000, toTokens: 1_100 }], 0.1, 1)).toBe(
      true,
    );
  });
});

propertyTest("increasing context usage cannot reduce pressure", {
  propertyId: "substrate.context-budget.pressure-monotonic",
  layer: "unit",
  arbitraries: [
    fc
      .tuple(
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 1_000, max: 220_000 }),
      )
      .map(([first, second, window]) => ({
        low: Math.min(first, second),
        high: Math.max(first, second),
        window,
      })),
  ],
  predicate(input) {
    const low = deriveContextBudgetState({
      usage: usage(input.low, input.window),
      config: baseConfig,
    }).pressureRank;
    const high = deriveContextBudgetState({
      usage: usage(input.high, input.window),
      config: baseConfig,
    }).pressureRank;

    expect(high).toBeGreaterThanOrEqual(low);
  },
});
