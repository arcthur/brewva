import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("cost governance events", () => {
  test("records governance_cost_anomaly_detected when governance port flags anomaly", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cost-governance-detected-")),
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
  });

  test("records governance_cost_anomaly_error when governance port throws", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cost-governance-error-")),
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
  });
});
