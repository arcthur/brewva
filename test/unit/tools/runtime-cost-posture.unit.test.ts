import { describe, expect, test } from "bun:test";
import { createRuntimeConfig, createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type RuntimeCostPostureView = {
  readonly status: string;
  readonly salience: string;
  readonly totalCostUsd: number;
  readonly budgetLimitUsd: number | null;
  readonly budgetRemainingUsd: number | null;
  readonly usageRatio: number | null;
  readonly alertThresholdRatio: number | null;
  readonly actionOnExceed: string;
  readonly softGate: {
    readonly required: boolean;
    readonly reason: string | null;
  };
};

function readCostPosture(
  runtime: ReturnType<typeof createRuntimeInstanceFixture>,
  sessionId: string,
): RuntimeCostPostureView {
  const getPosture = (
    runtime.ops.cost as {
      readonly posture?: { readonly get?: (sessionId: string) => RuntimeCostPostureView };
    }
  ).posture?.get;
  expect(typeof getPosture).toBe("function");
  if (typeof getPosture !== "function") {
    throw new Error("runtime cost posture getter is missing");
  }
  return getPosture(sessionId);
}

describe("runtime cost posture", () => {
  test("reports tracked cost without inventing a budget gate when no session limit is configured", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-cost-posture-unlimited"),
    });
    const sessionId = "cost-posture-unlimited";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 10,
      outputTokens: 12,
      costUsd: 0.42,
    });

    const posture = readCostPosture(runtime, sessionId);

    expect(posture).toMatchObject({
      status: "ok",
      salience: "default",
      budgetLimitUsd: null,
      budgetRemainingUsd: null,
      usageRatio: null,
      alertThresholdRatio: null,
      actionOnExceed: "off",
      softGate: { required: false, reason: null },
    });
    expect(posture.totalCostUsd).toBeCloseTo(0.42);
  });

  test("warns when tracked cost crosses the configured alert threshold", () => {
    const runtimeConfig = createRuntimeConfig((draft) => {
      draft.infrastructure.costTracking.maxCostUsdPerSession = 10;
      draft.infrastructure.costTracking.alertThresholdRatio = 0.5;
      draft.infrastructure.costTracking.actionOnExceed = "warn";
    });
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-cost-posture-warning"),
      config: runtimeConfig,
    });
    const sessionId = "cost-posture-warning";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      costUsd: 5.2,
    });

    const posture = readCostPosture(runtime, sessionId);

    expect(posture).toMatchObject({
      status: "warn",
      salience: "elevated",
      budgetLimitUsd: 10,
      actionOnExceed: "warn",
      softGate: { required: true, reason: "alert_threshold" },
    });
    expect(posture.budgetRemainingUsd).toBeCloseTo(4.8);
    expect(posture.usageRatio).toBeCloseTo(0.52);
    expect(posture.alertThresholdRatio).toBeCloseTo(0.5);
  });

  test("blocks when tracked cost exceeds a block_tools session budget", () => {
    const runtimeConfig = createRuntimeConfig((draft) => {
      draft.infrastructure.costTracking.maxCostUsdPerSession = 1;
      draft.infrastructure.costTracking.alertThresholdRatio = 0.8;
      draft.infrastructure.costTracking.actionOnExceed = "block_tools";
    });
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("runtime-cost-posture-blocked"),
      config: runtimeConfig,
    });
    const sessionId = "cost-posture-blocked";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      costUsd: 1.25,
    });

    const posture = readCostPosture(runtime, sessionId);
    const summary = runtime.ops.cost.summary.get(sessionId);

    expect(posture).toMatchObject({
      status: "blocked",
      salience: "alert",
      budgetLimitUsd: 1,
      budgetRemainingUsd: 0,
      actionOnExceed: "block_tools",
      softGate: { required: true, reason: "budget_exceeded" },
    });
    expect(posture.usageRatio).toBeCloseTo(1.25);
    expect(summary.budget).toMatchObject({
      action: "block_tools",
      sessionExceeded: true,
      blocked: true,
    });
  });
});
