import { describe, expect, test } from "bun:test";
import {
  createMockExtensionApi,
  createRuntimeFixture,
  invokeHandlerAsync,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform budgeting contract", () => {
  test("injects advisory metadata for non-critical pending compaction without arming the gate", async () => {
    const { api, handlers } = createMockExtensionApi();
    const eventTypes: string[] = [];
    const advisoryPayloads: Record<string, unknown>[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
      },
      events: {
        record: (input: { type: string; payload?: object }) => {
          eventTypes.push(input.type);
          if (input.type === "context_compaction_advisory" && input.payload) {
            advisoryPayloads.push(input.payload as Record<string, unknown>);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionId = "s-pending-compaction-advisory";
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 850,
      contextWindow: 1000,
      percent: 0.85,
    });
    runtime.operator.context.compaction.request(sessionId, "usage_threshold");

    const result = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue the investigation",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getContextUsage: () => ({ tokens: 850, contextWindow: 1000, percent: 0.85 }),
      },
    );

    expect(result.systemPrompt).toContain("[Brewva Context Contract]");
    expect(result.message?.content).toContain("[Context Status]");
    expect(result.message?.content?.includes("pending_compaction_reason: usage_threshold")).toBe(
      true,
    );
    expect(result.message?.content?.includes("compaction_advised: yes")).toBe(true);
    expect(result.message?.content?.includes("forced_compaction: no")).toBe(true);
    expect(result.message?.content?.includes("tape_pressure:")).toBe(false);
    expect(result.message?.content).toContain("[ContextCompactionAdvisory]");
    expect(result.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).toContain("context_composed");
    expect(eventTypes).toContain("context_compaction_advisory");
    expect(advisoryPayloads).toHaveLength(1);
    expect(advisoryPayloads[0]?.reason).toBe("usage_threshold");
    expect(advisoryPayloads[0]?.requiredTool).toBe("workbench_compact");
    expect(advisoryPayloads[0]?.compactionAdvised).toBe(true);
    expect(advisoryPayloads[0]?.forcedCompaction).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
    expect(eventTypes).not.toContain("critical_without_compact");
  });
});
