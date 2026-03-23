import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("cost governance events", () => {
  test("does not record governance anomaly events when the governance port reports no anomaly", async () => {
    const workspace = createTestWorkspace("cost-governance-none");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    let inspectedSummary:
      | {
          sessionId: string;
          totalTokens: number;
          totalCostUsd: number;
        }
      | undefined;
    try {
      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config,
        governancePort: {
          detectCostAnomaly: ({ sessionId, summary }) => {
            inspectedSummary = {
              sessionId,
              totalTokens: summary.totalTokens,
              totalCostUsd: summary.totalCostUsd,
            };
            return {
              anomaly: false,
              reason: "within_budget",
            };
          },
        },
      });
      const sessionId = "cost-governance-none-1";
      runtime.context.onTurnStart(sessionId, 1);

      runtime.cost.recordAssistantUsage({
        sessionId,
        model: "test/model",
        inputTokens: 60,
        outputTokens: 15,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 75,
        costUsd: 0.0009,
      });

      await flushAsyncEvents();

      expect(inspectedSummary).toEqual({
        sessionId,
        totalTokens: 75,
        totalCostUsd: 0.0009,
      });
      expect(runtime.events.query(sessionId, { type: "cost_update" })).toHaveLength(1);
      expect(
        runtime.events.query(sessionId, { type: "governance_cost_anomaly_detected" }),
      ).toHaveLength(0);
      expect(
        runtime.events.query(sessionId, { type: "governance_cost_anomaly_error" }),
      ).toHaveLength(0);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("records governance_cost_anomaly_detected when governance port flags anomaly", async () => {
    const workspace = createTestWorkspace("cost-governance-detected");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    try {
      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config,
        governancePort: {
          detectCostAnomaly: () => ({
            anomaly: true,
            reason: "looping_token_burn",
          }),
        },
      });
      const sessionId = "cost-governance-detected-1";
      runtime.context.onTurnStart(sessionId, 1);

      runtime.cost.recordAssistantUsage({
        sessionId,
        model: "test/model",
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 0.002,
      });

      await flushAsyncEvents();

      const events = runtime.events.query(sessionId, { type: "governance_cost_anomaly_detected" });
      expect(events).toHaveLength(1);
      const payload = events[0]?.payload as { reason?: string; totalTokens?: number } | undefined;
      expect(payload?.reason).toBe("looping_token_burn");
      expect(payload?.totalTokens).toBe(150);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("records governance_cost_anomaly_error when governance port throws", async () => {
    const workspace = createTestWorkspace("cost-governance-error");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    try {
      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config,
        governancePort: {
          detectCostAnomaly: () => {
            throw new Error("cost-anomaly-check-failed");
          },
        },
      });
      const sessionId = "cost-governance-error-1";
      runtime.context.onTurnStart(sessionId, 1);

      runtime.cost.recordAssistantUsage({
        sessionId,
        model: "test/model",
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 100,
        costUsd: 0.001,
      });

      await flushAsyncEvents();

      const events = runtime.events.query(sessionId, { type: "governance_cost_anomaly_error" });
      expect(events).toHaveLength(1);
      const payload = events[0]?.payload as { error?: string } | undefined;
      expect(payload?.error).toContain("cost-anomaly-check-failed");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
