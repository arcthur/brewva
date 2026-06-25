import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE } from "@brewva/brewva-vocabulary/context";
import { createHostedCompactionController } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/hosted/internal/context/hosted-context-telemetry.js";
import { createRuntimeConfig, createRuntimeFixture } from "../../helpers/runtime.js";

function controllerRuntime() {
  return createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.infrastructure.contextBudget.thresholds.hardRatio = 0.9;
      config.infrastructure.contextBudget.thresholds.advisoryRatio = 0.75;
      config.infrastructure.contextBudget.thresholds.headroomTokens = 1_000;
    }),
  });
}

describe("hosted auto-compaction controller — ineffective guard on the live path", () => {
  test("context() defers auto-compaction when recent committed reductions are ineffective", () => {
    const runtime = controllerRuntime();
    const telemetry = createHostedContextTelemetry(runtime);
    const controller = createHostedCompactionController(runtime, telemetry);
    const sessionId = "controller-ineffective";
    const usage = { tokens: 8_000, contextWindow: 10_000, percent: 80, maxOutputTokens: 1_000 };

    controller.turnStart({ sessionId, turnIndex: 10, timestamp: 1 });
    runtime.ops.context.lifecycle.onTurnStart(sessionId, 10);
    // Two old (post-cooldown) committed receipts that each reduced only ~5% — below
    // the 0.1 shrink floor — so the live auto path should defer rather than thrash.
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "c1",
      sourceTurn: 1,
      firstKeptEntryId: "e1",
      fromTokens: 10_000,
      toTokens: 9_600,
    });
    runtime.ops.session.compaction.commit(sessionId, {
      compactId: "c2",
      sourceTurn: 2,
      firstKeptEntryId: "e2",
      fromTokens: 10_000,
      toTokens: 9_500,
    });

    let compactCalled = false;
    controller.context({
      sessionId,
      usage,
      hasUI: true,
      idle: true,
      compact: () => {
        compactCalled = true;
      },
    });

    expect(compactCalled).toBe(false);
    const skipped = runtime.ops.events.records
      .query(sessionId, { type: CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE })
      .at(-1)?.payload;
    expect(skipped).toMatchObject({ reason: "compaction_ineffective" });
  });
});
