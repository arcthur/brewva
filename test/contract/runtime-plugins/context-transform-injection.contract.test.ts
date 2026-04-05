import { describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import type { SkillDocument } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  CONTEXT_SOURCES,
  createMockRuntimePluginApi,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandlerAsync,
  invokeHandlersAsync,
  makeInjectedEntry,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform injection contract", () => {
  test("passes the session leaf id into runtime context injection", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
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
    const { api, handlers } = createMockRuntimePluginApi();
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
      throw new Error("Expected context-transform result from createHostedTurnPipeline.");
    }

    expect(calls).toEqual(["async"]);
    expect(result.message.content).toContain("[TaskState]\nstatus: async");
  });

  test("does not inject delegation recommendations into hidden context", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const extensionApi = api as unknown as {
      registerTool: (tool: { name: string; description: string; parameters?: unknown }) => void;
    };
    extensionApi.registerTool({
      name: "subagent_run",
      description: "Delegate work to an isolated subagent.",
      parameters: { type: "object", properties: {} },
    });

    const sessionId = "s-no-delegation-recommendation";
    const activeSkill: SkillDocument = {
      name: "review",
      description: "Review skill fixture",
      category: "core",
      filePath: "/tmp/review/SKILL.md",
      baseDir: "/tmp/review",
      markdown: "# review",
      contract: {
        name: "review",
        category: "core",
        intent: {
          outputs: ["findings"],
        },
        effects: {
          allowedEffects: ["workspace_read", "runtime_observe"],
        },
        executionHints: {
          preferredTools: ["read"],
          fallbackTools: ["grep"],
        },
      },
      resources: {
        references: [],
        scripts: [],
        heuristics: [],
        invariants: [],
      },
      sharedContextFiles: [],
      overlayFiles: [],
    };
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig(),
      context: {
        checkAndRequestCompaction: () => false,
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
    Object.assign(runtime.inspect.skills, {
      getActive(activeSessionId: string) {
        return activeSessionId === sessionId ? activeSkill : undefined;
      },
    });

    registerContextTransform(api, runtime);

    const results = await invokeHandlersAsync<{
      message?: {
        content?: string;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "review this change for regression risk and correctness issues",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getContextUsage: () => undefined,
      },
    );
    const result = results.find((candidate) => typeof candidate?.message?.content === "string");
    expect(result?.message?.content).not.toContain("[DelegationRecommendation]");
  });

  test("surfaces completed delegation outcomes once and marks the handoff as surfaced", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const sessionId = "s-completed-delegation-outcome";
    const runtime = createRuntimeFixture({
      context: {
        checkAndRequestCompaction: () => false,
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
    const delegationStore = new HostedDelegationStore(runtime);

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "subagent_completed",
      payload: {
        runId: "run-completed-1",
        delegate: "advisor",
        status: "completed",
        kind: "consult",
        consultKind: "review",
        summary: "Review completed and awaits parent consumption.",
        deliveryMode: "text_only",
        deliveryHandoffState: "pending_parent_turn",
        deliveryReadyAt: 2,
        deliveryUpdatedAt: 2,
      },
    });

    registerContextTransform(api, runtime, { delegationStore });

    const firstResults = await invokeHandlersAsync<{
      message?: {
        content?: string;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getContextUsage: () => undefined,
      },
    );
    const first = firstResults.find((candidate) => typeof candidate?.message?.content === "string");
    expect(first?.message?.content).toContain("[CompletedDelegationOutcomes]");
    expect(first?.message?.content).toContain("run-completed-1");
    expect(delegationStore.getRun(sessionId, "run-completed-1")?.delivery?.handoffState).toBe(
      "surfaced",
    );
    expect(
      runtime.inspect.events.list(sessionId, { type: "subagent_delivery_surfaced" }),
    ).toHaveLength(1);

    const secondResults = await invokeHandlersAsync<{
      message?: {
        content?: string;
      };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue",
        systemPrompt: "base prompt",
      },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getContextUsage: () => undefined,
      },
    );
    const second = secondResults.find(
      (candidate) => typeof candidate?.message?.content === "string",
    );
    expect(second?.message?.content ?? "").not.toContain("[CompletedDelegationOutcomes]");
    expect(
      runtime.inspect.events.list(sessionId, { type: "subagent_delivery_surfaced" }),
    ).toHaveLength(1);
  });
});
