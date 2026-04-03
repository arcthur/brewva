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

  test("adds a recovery working-set block after hosted recovery transitions", async () => {
    const runtime = createRuntimeFixture({
      context: {
        observeUsage: () => undefined,
        getCompactionGateStatus: () => ({
          required: false,
          reason: null,
          pressure: {
            level: "low",
            usageRatio: 0.2,
            hardLimitRatio: 0.95,
            compactionThresholdRatio: 0.8,
          },
          recentCompaction: false,
          windowTurns: 0,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        }),
        getPendingCompactionReason: () => null,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });
    const sessionId = "s-recovery-working-set";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Continue the interrupted task",
    });
    runtime.events.record({
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "provider_fallback_retry",
        status: "completed",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: "provider/model-b",
      },
    });

    const telemetry = createHostedContextTelemetry(runtime);
    const { api } = createMockRuntimePluginApi();
    const pipeline = createHostedContextInjectionPipeline(api, runtime, telemetry, {
      getTurnIndex: () => 3,
      setLastRuntimeGateRequired: () => undefined,
    });

    const result = await pipeline.beforeAgentStart({
      sessionId,
      sessionManager: {
        getLeafId: () => "leaf-recovery",
      },
      prompt: "resume",
      systemPrompt: "base prompt",
      usage: {
        tokens: 100,
        contextWindow: 4000,
        percent: 0.025,
      },
    });

    expect(result.message.content).toContain("[RecoveryWorkingSet]");
    expect(result.message.content).toContain("latest_reason: provider_fallback_retry");
    expect(result.message.content).toContain("task_goal: Continue the interrupted task");
  });
});
