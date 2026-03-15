import { describe, expect, test } from "bun:test";
import { setStaticContextPressureThresholds } from "../../fixtures/config.js";
import {
  createMockExtensionAPI,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandler,
  invokeHandlerAsync,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform session hook contract", () => {
  test("short-circuits routing and injection when the critical gate is required", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventPayloads: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let injectionCalls = 0;

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextPressureThresholds(config, { hardLimitPercent: 0.8 });
      }),
      context: {
        buildInjection: async () => {
          injectionCalls += 1;
          return {
            text: "[should-not-run]",
            entries: [],
            accepted: true,
            originalTokens: 1,
            finalTokens: 1,
            truncated: false,
          };
        },
      },
      events: {
        record: (input: { type: string; payload?: Record<string, unknown> }) => {
          eventPayloads.push({ type: input.type, payload: input.payload });
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
      message?: {
        content?: string;
        details?: {
          routingSelection?: { status?: string; reason?: string; selectedCount?: number };
        };
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "critical-turn",
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => "s-critical-short-circuit",
        },
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );

    expect(injectionCalls).toBe(0);
    expect(result.message?.content).toContain("[ContextCompactionGate]");
    expect(result.message?.details?.routingSelection?.status).toBe("skipped");
    expect(result.message?.details?.routingSelection?.reason).toBe("critical_compaction_gate");
    expect(result.message?.details?.routingSelection?.selectedCount).toBe(0);

    const selectionEvent = eventPayloads.find((event) => event.type === "skill_routing_selection");
    expect(selectionEvent?.payload?.status).toBe("skipped");
    expect(selectionEvent?.payload?.reason).toBe("critical_compaction_gate");
  });

  test("arms the critical gate for non-session_compact flows and clears it after compaction", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];
    const capturedCompactions: Array<Record<string, unknown>> = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextPressureThresholds(config, { hardLimitPercent: 0.8 });
      }),
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        markCompacted: (_sessionId: string, payload: Record<string, unknown>) => {
          capturedCompactions.push(payload);
        },
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
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-gate",
    };

    const before = await invokeHandlerAsync<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-1",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 950, contextWindow: 1000, percent: 0.95 }),
      },
    );

    expect(before.message?.content).toContain("[ContextCompactionGate]");
    expect(before.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(before.message?.content).not.toContain("tape_pressure:");
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
    expect(eventTypes).toContain("context_composed");
    expect(eventTypes).not.toContain("context_compaction_advisory");

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1 },
      {
        sessionManager,
      },
    );

    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-1",
          summary: "Keep active goals only.",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1200, contextWindow: 4096, percent: 0.29 }),
      },
    );

    expect(capturedCompactions).toHaveLength(1);
    expect(capturedCompactions[0]?.entryId).toBe("cmp-entry-1");
    expect(capturedCompactions[0]?.summary).toBe("Keep active goals only.");
    expect(capturedCompactions[0]?.toTokens).toBe(1200);
    expect(eventTypes).toContain("session_compact");
    expect(eventTypes).toContain("context_compaction_gate_cleared");
  });

  test("keeps the gate disarmed immediately after a recent compaction", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextPressureThresholds(config, { hardLimitPercent: 0.8 });
      }),
      context: {
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
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-recent-compact",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-entry-recent",
          summary: "recent compaction",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 1000, contextWindow: 4096, percent: 0.24 }),
      },
    );

    const before = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "round-after-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt).toContain("[Brewva Context Contract]");
    expect(before.message?.content).not.toContain("[OperationalDiagnostics]");
    expect(before.message?.content).not.toContain("[ContextCompactionGate]");
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });

  test("keeps the gate disarmed within the compaction window and rearms after it expires", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextPressureThresholds(config, { hardLimitPercent: 0.8 });
      }),
      context: {
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
        query: () => [],
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-window",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 3 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-window",
          summary: "window compact",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 500, contextWindow: 4096, percent: 0.12 }),
      },
    );

    invokeHandler(handlers, "turn_start", { turnIndex: 4 }, { sessionManager });
    const withinWindow = await invokeHandlerAsync<{
      message?: { content?: string };
      systemPrompt?: string;
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "within-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );
    expect(withinWindow.systemPrompt).toContain("[Brewva Context Contract]");
    expect(withinWindow.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(withinWindow.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");

    invokeHandler(handlers, "turn_start", { turnIndex: 5 }, { sessionManager });
    const afterWindow = await invokeHandlerAsync<{ message?: { content?: string } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "after-window",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 980, contextWindow: 1000, percent: 0.98 }),
      },
    );
    expect(afterWindow.message?.content).toContain("[ContextCompactionGate]");
    expect(afterWindow.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
  });

  test("keeps the gate disarmed when hydrated runtime state already reflects compaction", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        setStaticContextPressureThresholds(config, { hardLimitPercent: 0.8 });
      }),
      context: {
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
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-hydrate",
    };

    invokeHandler(handlers, "turn_start", { turnIndex: 7 }, { sessionManager });
    invokeHandler(
      handlers,
      "session_compact",
      {
        compactionEntry: {
          id: "cmp-hydrated-state",
          summary: "hydrated compact",
        },
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 300, contextWindow: 1000, percent: 0.3 }),
      },
    );
    invokeHandler(handlers, "turn_start", { turnIndex: 8 }, { sessionManager });

    const before = await invokeHandlerAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "hydrated-compact",
        systemPrompt: "base",
      },
      {
        sessionManager,
        getContextUsage: () => ({ tokens: 970, contextWindow: 1000, percent: 0.97 }),
      },
    );

    expect(before.systemPrompt).toContain("[Brewva Context Contract]");
    expect(before.message?.content?.includes("[OperationalDiagnostics]")).toBe(false);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });
});
