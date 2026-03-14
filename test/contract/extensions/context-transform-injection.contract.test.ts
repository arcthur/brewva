import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SOURCES,
  createMockExtensionAPI,
  createRuntimeFixture,
  invokeHandlerAsync,
  invokeHandlersAsync,
  makeInjectedEntry,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform injection contract", () => {
  test("passes the session leaf id into runtime context injection", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const scopes: Array<string | undefined> = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async (
          _sessionId: string,
          _prompt: string,
          _usage: unknown,
          scopeId?: string,
        ) => {
          scopes.push(scopeId);
          return {
            text: "",
            entries: [],
            accepted: false,
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
          };
        },
      },
    });

    registerContextTransform(api, runtime);

    await invokeHandlerAsync(
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
          getLeafId: () => "leaf-1",
        },
        getContextUsage: () => undefined,
      },
    );

    expect(scopes).toEqual(["leaf-1"]);
  });

  test("uses the async buildInjection result when the runtime returns it", async () => {
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
                "async-task-state",
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

    registerContextTransform(api, runtime);

    const results = await invokeHandlersAsync<{
      message: {
        content: string;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "prefer async",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => "s-async-pref",
        },
        getContextUsage: () => undefined,
      },
    );
    const result = results.find((candidate) =>
      candidate?.message?.content?.includes("[TaskState]\nstatus: async"),
    );
    if (!result) {
      throw new Error("Expected context-transform result from createBrewvaExtension.");
    }

    expect(calls).toEqual(["async"]);
    expect(result.message.content).toContain("[TaskState]\nstatus: async");
  });
});
