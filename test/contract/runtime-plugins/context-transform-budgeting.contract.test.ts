import { describe, expect, test } from "bun:test";
import {
  createMockRuntimePluginApi,
  createRuntimeFixture,
  invokeHandlerAsync,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform budgeting contract", () => {
  test("suppresses narrative context when injection is rejected by budget", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 4200,
          finalTokens: 0,
          truncated: false,
        }),
      },
    });

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "fix test failure",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s1-drop",
        },
        getContextUsage: () => ({ tokens: 520, contextWindow: 1000, percent: 0.52 }),
      },
    );

    expect(result.systemPrompt).toContain("[Brewva Context Contract]");
    expect(result.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(result.message?.content?.includes("[Brewva Context]")).toBe(false);
  });

  test("injects advisory metadata for non-critical pending compaction without arming the gate", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const eventTypes: string[] = [];
    const advisoryPayloads: Record<string, unknown>[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        buildInjection: async () => ({
          text: "",
          entries: [],
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
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
    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 850,
      contextWindow: 1000,
      percent: 0.85,
    });
    runtime.maintain.context.requestCompaction(sessionId, "usage_threshold");

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
    expect(result.message?.content).toContain("[OperationalDiagnostics]");
    expect(result.message?.content?.includes("pending_compaction_reason: usage_threshold")).toBe(
      true,
    );
    expect(result.message?.content?.includes("required_action: session_compact_recommended")).toBe(
      true,
    );
    expect(result.message?.content?.includes("tape_pressure:")).toBe(false);
    expect(result.message?.content).toContain("[ContextCompactionAdvisory]");
    expect(result.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).toContain("context_composed");
    expect(eventTypes).toContain("context_compaction_advisory");
    expect(advisoryPayloads).toHaveLength(1);
    expect(advisoryPayloads[0]?.reason).toBe("usage_threshold");
    expect(advisoryPayloads[0]?.requiredTool).toBe("session_compact");
    expect(advisoryPayloads[0]?.contextPressure).toBe("high");
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
    expect(eventTypes).not.toContain("critical_without_compact");
  });

  test("drops supplemental diagnostics when supplemental budget rejects them", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const runtime = createRuntimeFixture({
      context: {
        appendGuardedSupplementalBlocks: (
          _sessionId: string,
          blocks: readonly { familyId: string; content: string }[],
        ) =>
          blocks.map(({ familyId }) => ({
            familyId,
            accepted: false,
            text: "",
            originalTokens: 64,
            finalTokens: 0,
            truncated: false,
            droppedReason: "budget_exhausted" as const,
          })),
      },
    });

    registerContextTransform(api, runtime);

    const sessionId = "s-supplemental-drop";
    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 850,
      contextWindow: 1000,
      percent: 0.85,
    });
    runtime.maintain.context.requestCompaction(sessionId, "usage_threshold");

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

    expect(result.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(result.message?.content).toContain("[ContextCompactionAdvisory]");
  });
});
