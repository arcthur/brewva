import { describe, expect, test } from "bun:test";
import { createHostedTurnPipeline } from "@brewva/brewva-gateway/runtime-plugins";
import {
  createMockRuntimePluginApi,
  invokeHandler,
  invokeHandlerAsync,
  invokeHandlersAsync,
  invokeHandlers,
} from "../../helpers/runtime-plugin.js";
import {
  createRuntimeConfig,
  createRuntimeFixture as createBaseRuntimeFixture,
} from "../../helpers/runtime.js";

interface RuntimeCalls {
  started: Array<Record<string, unknown>>;
  finished: Array<Record<string, unknown>>;
  compacted: Array<{ sessionId: string; input: Record<string, unknown> }>;
  events: Array<Record<string, unknown>>;
  cleared: string[];
  observedContext: Array<{ sessionId: string; usage: unknown }>;
}

function createRuntimeFixture(
  input: {
    startAllowed?: boolean;
    startReason?: string;
    startAdvisory?: string;
  } = {},
) {
  const calls: RuntimeCalls = {
    started: [],
    finished: [],
    compacted: [],
    events: [],
    cleared: [],
    observedContext: [],
  };

  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = ["core", "domain"];
    }),
  });

  Object.assign(runtime.tools, {
    start(payload: Record<string, unknown>) {
      calls.started.push(payload);
      return {
        allowed: input.startAllowed ?? true,
        reason: input.startReason,
        advisory: input.startAdvisory,
      };
    },
    explainAccess() {
      return { allowed: true };
    },
    finish(payload: Record<string, unknown>) {
      calls.finished.push(payload);
    },
  });

  Object.assign(runtime.context, {
    markCompacted(sessionId: string, payload: Record<string, unknown>) {
      calls.compacted.push({ sessionId, input: payload });
    },
    observeUsage(sessionId: string, usage: unknown) {
      calls.observedContext.push({ sessionId, usage });
    },
    getUsage() {
      return { tokens: 320, contextWindow: 4096, percent: 0.078 };
    },
    getPressureStatus(_sessionId: string, usage?: { percent?: number }) {
      return {
        level: "low",
        usageRatio: typeof usage?.percent === "number" ? usage.percent : 0.078,
        hardLimitRatio: 0.98,
        compactionThresholdRatio: 0.8,
      };
    },
    async buildInjection() {
      return {
        text: "",
        entries: [],
        accepted: false,
        originalTokens: 0,
        finalTokens: 0,
        truncated: false,
      };
    },
    getCompactionGateStatus() {
      return {
        required: true,
        pressure: {
          level: "critical",
          usageRatio: 0.97,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        windowTurns: 2,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
      };
    },
    getCompactionThresholdRatio() {
      return 0.8;
    },
    getPendingCompactionReason() {
      return "hard_limit";
    },
    getHardLimitRatio() {
      return 0.98;
    },
    sanitizeInput(text: string) {
      return text;
    },
  });

  Object.assign(runtime.events, {
    record(payload: Record<string, unknown>) {
      calls.events.push(payload);
      return undefined;
    },
    query() {
      return [];
    },
    queryStructured() {
      return [];
    },
    getTapeStatus() {
      return {
        tapePressure: "medium",
        totalEntries: 42,
        entriesSinceAnchor: 7,
        entriesSinceCheckpoint: 4,
        lastAnchor: { id: "anchor-1", name: "phase-alpha" },
        thresholds: { low: 5, medium: 20, high: 50 },
      };
    },
    getTapePressureThresholds() {
      return { low: 5, medium: 20, high: 50 };
    },
  });

  Object.assign(runtime.task, {
    getState() {
      return {
        spec: {
          goal: "Stabilize hosted pipeline behavior.",
        },
        status: {
          phase: "execute",
        },
        items: [],
        blockers: [],
      };
    },
  });

  Object.assign(runtime.skills, {
    getActive() {
      return null;
    },
    get() {
      return undefined;
    },
  });

  Object.assign(runtime.session, {
    clearState(sessionId: string) {
      calls.cleared.push(sessionId);
    },
  });

  return { runtime, calls };
}

function createSessionContext(sessionId: string): {
  sessionManager: { getSessionId: () => string };
  getContextUsage: () => { tokens: number; contextWindow: number; percent: number };
} {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    getContextUsage: () => ({ tokens: 320, contextWindow: 4096, percent: 0.078 }),
  };
}

describe("hosted turn pipeline", () => {
  test("registers the canonical hosted handlers", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    })(api);

    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("input")).toBe(true);
    expect(handlers.has("context")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("tool_execution_start")).toBe(true);
    expect(handlers.has("tool_execution_end")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("session_compact")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  test("composes context through before_agent_start on the canonical hosted pipeline", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    })(api);

    const results = await invokeHandlersAsync<{
      systemPrompt?: string;
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue task",
        systemPrompt: "base prompt",
      },
      createSessionContext("hosted-before-start"),
    );
    const beforeStart = results.find(
      (result) =>
        typeof result?.systemPrompt === "string" || typeof result?.message?.content === "string",
    );

    expect(beforeStart?.systemPrompt).toContain("[Brewva Context Contract]");
    expect(beforeStart?.message?.content).toContain("[ContextCompactionGate]");
    expect(calls.events.map((event) => event.type)).toContain("context_composed");
    expect(calls.observedContext).toHaveLength(1);
    expect(calls.observedContext[0]?.sessionId).toBe("hosted-before-start");
  });

  test("routes tool_call blocking through the hosted pipeline quality gate", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture({
      startAllowed: false,
      startReason: "blocked-by-runtime",
    });
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    })(api);

    const result = invokeHandler<{ block?: boolean; reason?: string }>(
      handlers,
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "tool-call-1",
        toolName: "exec",
        input: { command: "pwd" },
      },
      {
        ...createSessionContext("hosted-tool-call"),
        getContextUsage: () => ({ tokens: 200, contextWindow: 4000, percent: 0.05 }),
      },
    );

    expect(result).toEqual({
      block: true,
      reason: "blocked-by-runtime",
    });
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0]?.toolCallId).toBe("tool-call-1");
  });

  test("uses tool_execution_end only as fallback finalize source", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    })(api);

    invokeHandlers(
      handlers,
      "tool_execution_start",
      {
        type: "tool_execution_start",
        toolCallId: "tool-fallback",
        toolName: "exec",
        args: { command: "pwd" },
      },
      createSessionContext("hosted-fallback"),
    );

    invokeHandlers(
      handlers,
      "tool_execution_end",
      {
        type: "tool_execution_end",
        toolCallId: "tool-fallback",
        toolName: "exec",
        result: { text: "done", details: { status: "ok" } },
        isError: false,
      },
      createSessionContext("hosted-fallback"),
    );

    expect(calls.finished).toHaveLength(1);
    expect(calls.finished[0]?.toolCallId).toBe("tool-fallback");
    expect(
      (calls.finished[0]?.metadata as { lifecycleFallbackReason?: string | null } | undefined)
        ?.lifecycleFallbackReason,
    ).toBe("tool_execution_end_without_tool_result");
  });

  test("cleans runtime session state on hosted pipeline shutdown", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    })(api);

    await invokeHandlerAsync(
      handlers,
      "session_shutdown",
      { type: "session_shutdown" },
      createSessionContext("hosted-shutdown"),
    );

    expect(calls.cleared).toContain("hosted-shutdown");
  });
});
