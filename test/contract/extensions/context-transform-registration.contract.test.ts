import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SOURCES,
  createHostedTurnPipeline,
  createMockExtensionAPI,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandlerAsync,
  invokeHandlersAsync,
  makeInjectedEntry,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform registration contract", () => {
  test("registers handlers and injects a hidden context message before agent start", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "[TaskState]\nstatus: active",
          entries: [
            makeInjectedEntry(
              CONTEXT_SOURCES.taskState,
              "task-state",
              "[TaskState]\nstatus: active",
            ),
          ],
          accepted: true,
          originalTokens: 42,
          finalTokens: 42,
          truncated: false,
        }),
      },
    });

    registerContextTransform(api, runtime);

    expect(handlers.has("context")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(false);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("turn_end")).toBe(false);
    expect(handlers.has("agent_end")).toBe(false);

    const result = await invokeHandlerAsync<{
      systemPrompt?: string;
      message: {
        customType: string;
        content: string;
        display: boolean;
      };
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
          getSessionId: () => "s1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(result.message.customType).toBe("brewva-context-injection");
    expect(result.message.display).toBe(false);
    expect(result.message.content).toContain("[TaskState]");
    expect(result.message.content).toContain("status: active");
    expect(result.systemPrompt).toContain("[Brewva Context Contract]");
  });

  test("surfaces capabilityView detailNames in hidden context metadata", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const extensionApi = api as unknown as {
      registerTool: (tool: { name: string; description: string; parameters?: unknown }) => void;
    };
    extensionApi.registerTool({
      name: "obs_query",
      description: "Query runtime events.",
      parameters: { type: "object", properties: {} },
    });
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "[TaskState]\nstatus: active",
          entries: [
            makeInjectedEntry(
              CONTEXT_SOURCES.taskState,
              "task-state",
              "[TaskState]\nstatus: active",
            ),
          ],
          accepted: true,
          originalTokens: 42,
          finalTokens: 42,
          truncated: false,
        }),
      },
    });

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
      message: {
        details?: {
          capabilityView?: {
            requested?: string[];
            detailNames?: string[];
            missing?: string[];
          };
        };
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "inspect $obs_query and $missing_tool",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s-capability-view",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(result.message.details?.capabilityView).toEqual({
      requested: ["obs_query", "missing_tool"],
      detailNames: ["obs_query"],
      missing: ["missing_tool"],
    });
  });

  test("does not emit deprecated routing telemetry from the real runtime path", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.projection.enabled = false;
        config.infrastructure.toolFailureInjection.enabled = false;
        config.infrastructure.toolOutputDistillationInjection.enabled = false;
      }),
    });
    const sessionId = "s-governance-routing";

    registerContextTransform(api, runtime);

    const prompt = "Review architecture risks, merge safety, and quality audit gaps";
    const result = await invokeHandlerAsync<{ message: { details?: Record<string, unknown> } }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt,
        systemPrompt: "base",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getContextUsage: () => undefined,
      },
    );

    expect(runtime.events.query(sessionId, { type: "skill_routing_selection", last: 1 })).toEqual(
      [],
    );
    expect(result.message.details?.routingSelection).toBeUndefined();

    const summary = runtime.cost.getSummary(sessionId);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
  });

  test("preserves async context injection through createHostedTurnPipeline", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const calls: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => {
          calls.push("async");
          return {
            text: "[TaskState]\nstatus: async",
            entries: [
              makeInjectedEntry(
                CONTEXT_SOURCES.taskState,
                "factory-async-task-state",
                "[TaskState]\nstatus: async",
              ),
            ],
            accepted: true,
            originalTokens: 2,
            finalTokens: 2,
            truncated: false,
          };
        },
      },
    });

    const extension = createHostedTurnPipeline({
      runtime,
      registerTools: false,
    });
    await extension(api);

    const results = await invokeHandlersAsync<{
      message: {
        content: string;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "factory async path",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s-factory-async",
        },
        getContextUsage: () => undefined,
      },
    );
    const result = results.find(
      (value): value is { message: { content: string } } =>
        typeof value === "object" &&
        value !== null &&
        "message" in value &&
        typeof (value as { message?: { content?: unknown } }).message?.content === "string",
    );

    expect(calls).toEqual(["async"]);
    expect(result?.message.content).toContain("[TaskState]\nstatus: async");
  });
});
