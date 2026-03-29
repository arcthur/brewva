import { describe, expect, test } from "bun:test";
import type { ContextBudgetUsage, ContextCompactionGateStatus } from "@brewva/brewva-runtime";
import { createHostedContextInjectionPipeline } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
import { createMockRuntimePluginApi } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

const HIGH_USAGE: ContextBudgetUsage = {
  tokens: 995,
  contextWindow: 1000,
  percent: 0.995,
};

const HARD_GATE_STATUS: ContextCompactionGateStatus = {
  required: true,
  reason: "hard_limit",
  pressure: {
    level: "critical",
    usageRatio: 0.995,
    hardLimitRatio: 0.95,
    compactionThresholdRatio: 0.8,
  },
  recentCompaction: false,
  windowTurns: 0,
  lastCompactionTurn: null,
  turnsSinceCompaction: null,
};

describe("hosted context injection pipeline", () => {
  test("fails closed on a hard gate without calling buildInjection", async () => {
    const recordedTypes: string[] = [];
    let buildInjectionCalls = 0;
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => HARD_GATE_STATUS,
        getPendingCompactionReason: () => "hard_limit",
        buildInjection: async () => {
          buildInjectionCalls += 1;
          return {
            text: "unexpected",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          };
        },
      },
      events: {
        record: (input: { type: string }) => {
          recordedTypes.push(input.type);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const gateWrites: Array<{ sessionId: string; required: boolean }> = [];
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 12,
      setLastRuntimeGateRequired: (sessionId, required) => {
        gateWrites.push({ sessionId, required });
      },
    });

    const result = await pipeline.beforeAgentStart({
      sessionId: "s-gated",
      sessionManager: {
        getLeafId: () => "leaf-gated",
      },
      prompt: "continue",
      systemPrompt: "base prompt",
      usage: HIGH_USAGE,
    });

    expect(buildInjectionCalls).toBe(0);
    expect(gateWrites).toEqual([{ sessionId: "s-gated", required: true }]);
    expect(result.message.customType).toBe("brewva-context-injection");
    expect(result.message.display).toBe(false);
    expect(result.message.details.gateRequired).toBe(true);
    expect(recordedTypes).toContain("context_compaction_gate_armed");
    expect(recordedTypes).toContain("critical_without_compact");
    expect(recordedTypes).toContain("context_composed");
  });
});
