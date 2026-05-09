import { describe, expect, test } from "bun:test";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createContextBudgetManager } from "@brewva/brewva-runtime/context";
import { estimateTokenCount } from "@brewva/brewva-token-estimation";

describe("Context budget manager", () => {
  test("uses conservative token estimate for injection decisions", () => {
    const manager = createContextBudgetManager({
      ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    });

    const decision = manager.planDynamicTailAdmission("budget-conservative-1", "x".repeat(15), {
      tokens: 500,
      contextWindow: 2000,
      percent: 0.25,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.originalTokens).toBe(estimateTokenCount("x".repeat(15)));
    expect(decision.finalTokens).toBe(decision.originalTokens);
  });

  test("applies conservative truncation at token boundary", () => {
    const budgetConfig = structuredClone(DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget);
    budgetConfig.dynamicTail.baseTokens = 32;
    budgetConfig.dynamicTail.windowFraction = 0;
    budgetConfig.dynamicTail.maxTokens = 32;
    const manager = createContextBudgetManager(budgetConfig);

    const inputText = Array.from({ length: 200 }, (_, index) => `token${index}`).join(" ");

    const decision = manager.planDynamicTailAdmission("budget-conservative-2", inputText);
    expect(decision.accepted).toBe(true);
    expect(decision.finalText.length).toBeLessThan(inputText.length);
    expect(decision.finalTokens).toBeLessThanOrEqual(32);
    expect(estimateTokenCount(decision.finalText)).toBeLessThanOrEqual(32);
  });

  test("applies wall-clock cooldown between compactions", () => {
    let nowMs = 1_000;
    const manager = createContextBudgetManager(
      {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
      },
      {
        now: () => nowMs,
      },
    );
    const sessionId = "budget-cooldown-time";

    manager.beginTurn(sessionId, 1);
    const first = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_650,
      contextWindow: 2_000,
      percent: 0.825,
    });
    expect(first.shouldCompact).toBe(true);
    expect(first.reason).toBe("usage_threshold");
    manager.markCompacted(sessionId);

    manager.beginTurn(sessionId, 2);
    nowMs += 10_000;
    const second = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_660,
      contextWindow: 2_000,
      percent: 0.83,
    });
    expect(second.shouldCompact).toBe(false);

    manager.beginTurn(sessionId, 3);
    nowMs += 36_000;
    const third = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_680,
      contextWindow: 2_000,
      percent: 0.84,
    });
    expect(third.shouldCompact).toBe(true);
    expect(third.reason).toBe("usage_threshold");
  });

  test("bypasses cooldown under high pressure", () => {
    let nowMs = 5_000;
    const budgetConfig = structuredClone(DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget);
    budgetConfig.thresholds.hardLimitFloorPercent = 0.98;
    budgetConfig.thresholds.hardLimitCeilingPercent = 0.98;
    const manager = createContextBudgetManager(budgetConfig, {
      now: () => nowMs,
    });
    const sessionId = "budget-cooldown-bypass";

    manager.beginTurn(sessionId, 1);
    manager.markCompacted(sessionId);

    manager.beginTurn(sessionId, 2);
    nowMs += 1_000;
    const pressure = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_900,
      contextWindow: 2_000,
      percent: 0.95,
    });
    expect(pressure.shouldCompact).toBe(true);
    expect(pressure.reason).toBe("usage_threshold");

    manager.beginTurn(sessionId, 3);
    nowMs += 1_000;
    const continuedPressure = manager.shouldRequestCompaction(sessionId, {
      tokens: 1_900,
      contextWindow: 2_000,
      percent: 0.95,
    });
    expect(continuedPressure.shouldCompact).toBe(true);
    expect(continuedPressure.reason).toBe("usage_threshold");
  });

  test("normalizes percentage-point context usage into ratio", () => {
    const manager = createContextBudgetManager({
      ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    });
    const sessionId = "budget-percent-points";

    manager.beginTurn(sessionId, 1);
    const lowUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 3_597,
      contextWindow: 272_000,
      // 1.322% from upstream telemetry, not 132.2%
      percent: 1.3224264705882354,
    });
    expect(lowUsage.shouldCompact).toBe(false);

    const subOnePercentUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 2_689,
      contextWindow: 272_000,
      // 0.9886% from upstream telemetry (percentage points below 1)
      percent: 0.9886029411764706,
    });
    expect(subOnePercentUsage.shouldCompact).toBe(false);

    const injection = manager.planDynamicTailAdmission(sessionId, "hello", {
      tokens: 3_597,
      contextWindow: 272_000,
      percent: 1.3224264705882354,
    });
    expect(injection.accepted).toBe(true);

    const highUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 258_400,
      contextWindow: 272_000,
      // 95% in percentage-point form
      percent: 95,
    });
    expect(highUsage.shouldCompact).toBe(true);
    expect(highUsage.reason).toBe("usage_threshold");

    const criticalUsage = manager.shouldRequestCompaction(sessionId, {
      tokens: 266_560,
      contextWindow: 272_000,
      // 98% in percentage-point form
      percent: 98,
    });
    expect(criticalUsage.shouldCompact).toBe(true);
    expect(criticalUsage.reason).toBe("hard_limit");
  });

  test("scales thresholds and injection budget with larger context windows", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const manager = createContextBudgetManager(config.infrastructure.contextBudget);
    const sessionId = "adaptive-budget-1";

    const largeWindowUsage = {
      tokens: 895_000,
      contextWindow: 1_000_000,
      percent: 0.895,
    };
    expect(manager.getEffectiveCompactionThresholdPercent(sessionId, largeWindowUsage)).toBe(0.9);
    expect(manager.getEffectiveHardLimitPercent(sessionId, largeWindowUsage)).toBe(0.97);
    expect(manager.getEffectiveDynamicTailTokenBudget(sessionId, largeWindowUsage)).toBe(3200);

    const smallWindowUsage = {
      tokens: 26_000,
      contextWindow: 32_000,
      percent: 0.8125,
    };
    expect(manager.getEffectiveCompactionThresholdPercent(sessionId, smallWindowUsage)).toBe(0.82);
    expect(manager.getEffectiveHardLimitPercent(sessionId, smallWindowUsage)).toBe(0.94);
    expect(manager.getEffectiveDynamicTailTokenBudget(sessionId, smallWindowUsage)).toBe(1264);
  });

  test("falls back to tokens/contextWindow when percent telemetry is missing", () => {
    const manager = createContextBudgetManager({
      ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    });
    const sessionId = "adaptive-budget-null-percent";

    const decision = manager.planDynamicTailAdmission(sessionId, "hello", {
      tokens: 195_000,
      contextWindow: 200_000,
      percent: null,
    });
    expect(decision.accepted).toBe(false);
    expect(decision.droppedReason).toBe("hard_limit");

    const compaction = manager.shouldRequestCompaction(sessionId, {
      tokens: 183_000,
      contextWindow: 200_000,
      percent: null,
    });
    expect(compaction.shouldCompact).toBe(true);
    expect(compaction.reason).toBe("usage_threshold");
  });

  test("caps injection to stay below the projected hard limit", () => {
    const manager = createContextBudgetManager({
      ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    });
    const sessionId = "adaptive-budget-projected-hard-limit";

    const decision = manager.planDynamicTailAdmission(sessionId, "x".repeat(20_000), {
      tokens: 969_000,
      contextWindow: 1_000_000,
      percent: 0.969,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.finalTokens).toBeLessThanOrEqual(999);
  });

  test("clamps injection to the remaining hard-limit headroom even when nominal adaptive budget is larger", () => {
    const manager = createContextBudgetManager({
      ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
    });
    const sessionId = "adaptive-budget-remaining-headroom";

    const decision = manager.planDynamicTailAdmission(sessionId, "x".repeat(20_000), {
      tokens: 969_500,
      contextWindow: 1_000_000,
      percent: 0.9695,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.finalTokens).toBeLessThanOrEqual(499);
  });

  test("derives effective headroom from provider-reported maxOutputTokens when it exceeds configured headroom", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const configuredHardHeadroom =
      config.infrastructure.contextBudget.thresholds.hardLimitHeadroomTokens;
    const manager = createContextBudgetManager(config.infrastructure.contextBudget);
    const sessionId = "max-output-headroom-1";

    const usageWithoutMaxOutput = {
      tokens: 0,
      contextWindow: 200_000,
      percent: 0,
    };
    const usageWithLargerMaxOutput = {
      ...usageWithoutMaxOutput,
      maxOutputTokens: configuredHardHeadroom + 50_000,
    };
    const usageWithSmallerMaxOutput = {
      ...usageWithoutMaxOutput,
      maxOutputTokens: Math.max(1, Math.floor(configuredHardHeadroom / 2)),
    };

    const baselineHardPercent = manager.getEffectiveHardLimitPercent(
      sessionId,
      usageWithoutMaxOutput,
    );
    const adaptedHardPercent = manager.getEffectiveHardLimitPercent(
      sessionId,
      usageWithLargerMaxOutput,
    );
    const smallerHardPercent = manager.getEffectiveHardLimitPercent(
      sessionId,
      usageWithSmallerMaxOutput,
    );

    expect(adaptedHardPercent).toBeLessThan(baselineHardPercent);
    expect(smallerHardPercent).toBe(baselineHardPercent);
  });

  test("ignores invalid or non-positive maxOutputTokens values", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const manager = createContextBudgetManager(config.infrastructure.contextBudget);
    const sessionId = "max-output-headroom-2";

    const baseUsage = {
      tokens: 0,
      contextWindow: 200_000,
      percent: 0,
    };
    const baseline = manager.getEffectiveHardLimitPercent(sessionId, baseUsage);

    expect(
      manager.getEffectiveHardLimitPercent(sessionId, {
        ...baseUsage,
        maxOutputTokens: 0,
      }),
    ).toBe(baseline);
    expect(
      manager.getEffectiveHardLimitPercent(sessionId, {
        ...baseUsage,
        maxOutputTokens: -1000,
      }),
    ).toBe(baseline);
    expect(
      manager.getEffectiveHardLimitPercent(sessionId, {
        ...baseUsage,
        maxOutputTokens: Number.NaN,
      }),
    ).toBe(baseline);
    expect(
      manager.getEffectiveHardLimitPercent(sessionId, {
        ...baseUsage,
        maxOutputTokens: null,
      }),
    ).toBe(baseline);
  });
});
