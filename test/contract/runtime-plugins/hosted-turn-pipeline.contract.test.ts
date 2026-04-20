import { describe, expect, test } from "bun:test";
import {
  buildContextEvidenceReport,
  createHostedTurnPipeline,
  type LocalHookPort,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  createMockRuntimePluginApi,
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
    events: [],
    cleared: [],
    observedContext: [],
  };

  const runtime = createBaseRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.skills.routing.enabled = true;
      config.skills.routing.scopes = ["core", "domain"];
      config.infrastructure.events.level = "debug";
    }),
  });
  const rawEventQuery = runtime.inspect.events.query.bind(runtime.inspect.events);
  const rawEventQueryStructured = runtime.inspect.events.queryStructured.bind(
    runtime.inspect.events,
  );

  Object.assign(runtime.authority.tools, {
    start(payload: Record<string, unknown>) {
      calls.started.push(payload);
      return {
        allowed: input.startAllowed ?? true,
        reason: input.startReason,
        advisory: input.startAdvisory,
      };
    },
    finish(payload: Record<string, unknown>) {
      calls.finished.push(payload);
    },
  });

  Object.assign(runtime.inspect.tools, {
    explainAccess() {
      return { allowed: true };
    },
  });

  Object.assign(runtime.maintain.context, {
    observeUsage(sessionId: string, usage: unknown) {
      calls.observedContext.push({ sessionId, usage });
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
  });

  Object.assign(runtime.inspect.context, {
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

  runtime.inspect.events.subscribe((event) => {
    calls.events.push(event as unknown as Record<string, unknown>);
  });

  Object.assign(runtime.inspect.events, {
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

  Object.assign(runtime.inspect.task, {
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

  Object.assign(runtime.inspect.skills, {
    getActive() {
      return null;
    },
    get() {
      return undefined;
    },
  });

  Object.assign(runtime.maintain.session, {
    clearState(sessionId: string) {
      calls.cleared.push(sessionId);
    },
  });

  return { runtime, calls, rawEventQuery, rawEventQueryStructured };
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

function readEventPayload(event: Record<string, unknown>): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function invokeBeforeProviderRequestChain(
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >,
  payload: Record<string, unknown>,
  sessionId: string,
): Record<string, unknown> {
  let currentPayload = payload;
  for (const handler of handlers.get("before_provider_request") ?? []) {
    const nextPayload = handler(
      { payload: currentPayload },
      {
        sessionManager: {
          getSessionId: () => sessionId,
        },
      },
    );
    if (nextPayload && typeof nextPayload === "object" && !Array.isArray(nextPayload)) {
      currentPayload = nextPayload as Record<string, unknown>;
    }
  }
  return currentPayload;
}

describe("hosted turn pipeline", () => {
  test("registers the canonical hosted handlers", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    }).register(api);

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

  test("rejects routingDefaultScopes when an existing runtime is supplied", () => {
    const { api } = createMockRuntimePluginApi();
    const { runtime } = createRuntimeFixture();

    expect(() =>
      createHostedTurnPipeline({
        runtime,
        routingDefaultScopes: ["core", "domain"],
      }).register(api),
    ).toThrow(/routingDefaultScopes must be applied when constructing BrewvaRuntime/);
  });

  test("composes context through before_agent_start on the canonical hosted pipeline", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    }).register(api);

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

  test("runs local pre_classify hooks before hosted tool-surface resolution", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    const seenInputs: string[] = [];
    const localHook: LocalHookPort = {
      name: "local-classification-hint",
      preClassify(input) {
        seenInputs.push(`${input.phase}:${input.sessionId}:${input.prompt}`);
        return {
          kind: "recommend",
          recommendations: [
            {
              message: "Treat this as repository analysis.",
              classificationHint: {
                skillName: "repository-analysis",
                scoreBoost: 0.2,
                reason: "Local rule matched repository-analysis wording.",
              },
            },
          ],
        };
      },
    };

    await createHostedTurnPipeline({
      runtime,
      localHooks: [localHook],
    }).register(api);

    await invokeHandlersAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Analyze repository boundaries before changing code.",
        systemPrompt: "base prompt",
      },
      createSessionContext("hosted-local-hook-classify"),
    );

    expect(seenInputs).toEqual([
      "pre_classify:hosted-local-hook-classify:Analyze repository boundaries before changing code.",
    ]);

    const governanceIndex = calls.events.findIndex((event) => {
      const payload = readEventPayload(event);
      return event.type === "turn_governance_decision" && payload.phase === "pre_classify";
    });
    const toolSurfaceIndex = calls.events.findIndex(
      (event) => event.type === "tool_surface_resolved",
    );

    expect(governanceIndex).toBeGreaterThanOrEqual(0);
    expect(toolSurfaceIndex).toBeGreaterThan(governanceIndex);
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
    }).register(api);

    const results = await invokeHandlersAsync<{ block?: boolean; reason?: string }>(
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
    const result = results.find((entry) => entry?.block);

    expect(result).toEqual({
      block: true,
      reason: "blocked-by-runtime",
    });
    expect(calls.started).toHaveLength(1);
    expect(calls.started[0]?.toolCallId).toBe("tool-call-1");
  });

  test("local pre_tool blocks narrow execution before runtime authority starts", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    const localHook: LocalHookPort = {
      name: "local-tool-blocker",
      preTool(input) {
        expect(input.phase).toBe("pre_tool");
        expect(input.toolName).toBe("exec");
        return {
          kind: "block_tool",
          reason: "local policy denies exec",
        };
      },
    };

    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    let result: { block?: boolean; reason?: string } | undefined;
    for (const handler of handlers.get("tool_call") ?? []) {
      result = (await handler(
        {
          type: "tool_call",
          toolCallId: "tool-call-local-block",
          toolName: "exec",
          input: { command: "pwd" },
        },
        createSessionContext("hosted-local-hook-tool"),
      )) as { block?: boolean; reason?: string } | undefined;
      if (result?.block) {
        break;
      }
    }

    expect(result).toEqual({
      block: true,
      reason: "local policy denies exec",
    });
    expect(calls.started).toHaveLength(0);
    expect(
      calls.events.some((event) => {
        const payload = readEventPayload(event);
        return (
          event.type === "turn_governance_decision" &&
          payload.phase === "pre_tool" &&
          payload.hookName === "local-tool-blocker"
        );
      }),
    ).toBe(true);
  });

  test("local post_tool recommendations do not rewrite normalized tool results", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime } = createRuntimeFixture();
    const observed: Array<{
      contentText: string | undefined;
      detailValue: string | undefined;
    }> = [];
    const localHook: LocalHookPort = {
      name: "local-post-tool-observer",
      postTool(input) {
        expect(input.phase).toBe("post_tool");
        const contentText = input.content[0]?.type === "text" ? input.content[0].text : undefined;
        const detailValue = (input.details as { nested?: { value?: string } } | undefined)?.nested
          ?.value;
        observed.push({ contentText, detailValue });
        (input.content as Array<{ type: "text"; text: string }>)[0]!.text = "mutated";
        (input.details as { nested: { value: string } }).nested.value = "mutated";
        return {
          kind: "recommend",
          recommendations: [
            {
              message: `Observed ${input.toolName}.`,
            },
          ],
          content: [{ type: "text", text: "mutated" }],
        } as never;
      },
    };

    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    const content = [{ type: "text" as const, text: "original" }];
    const details = { nested: { value: "original-detail" } };
    const results = await invokeHandlersAsync<{ content?: unknown }>(
      handlers,
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "tool-result-local-observe",
        toolName: "read",
        input: { path: "README.md" },
        isError: false,
        content,
        details,
      },
      createSessionContext("hosted-local-hook-post-tool"),
    );

    expect(observed).toEqual([
      {
        contentText: "original",
        detailValue: "original-detail",
      },
    ]);
    expect(content[0]?.text).toBe("original");
    expect(details.nested.value).toBe("original-detail");
    expect(results.some((result) => result?.content !== undefined)).toBe(false);
  });

  test("uses tool_execution_end only as fallback finalize source", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    }).register(api);

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
    }).register(api);

    await invokeHandlerAsync(
      handlers,
      "session_shutdown",
      { type: "session_shutdown" },
      createSessionContext("hosted-shutdown"),
    );

    expect(calls.cleared).toContain("hosted-shutdown");
  });

  test("routes prompt stability, transient reduction, and message usage through the canonical hosted pipeline into context evidence readiness", async () => {
    const { api, handlers } = createMockRuntimePluginApi();
    const { runtime, rawEventQuery, rawEventQueryStructured } = createRuntimeFixture();
    const sessionId = "hosted-context-evidence-ready";
    let sessionUsage = { tokens: 320, contextWindow: 4096, percent: 0.078 };
    Object.assign(runtime.inspect.events, {
      query: rawEventQuery,
      queryStructured: rawEventQueryStructured,
    });
    Object.assign(runtime.inspect.context, {
      getUsage(requestedSessionId?: string) {
        if (requestedSessionId === sessionId) {
          return sessionUsage;
        }
        return { tokens: 320, contextWindow: 4096, percent: 0.078 };
      },
      getPressureStatus(_sessionId: string, usage?: { percent?: number }) {
        const usageRatio = typeof usage?.percent === "number" ? usage.percent : 0;
        if (usageRatio >= 0.98) {
          return {
            level: "critical",
            usageRatio,
            hardLimitRatio: 0.98,
            compactionThresholdRatio: 0.8,
          };
        }
        if (usageRatio >= 0.8) {
          return {
            level: "high",
            usageRatio,
            hardLimitRatio: 0.98,
            compactionThresholdRatio: 0.8,
          };
        }
        return {
          level: "low",
          usageRatio,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        };
      },
      getCompactionGateStatus(_sessionId: string, usage?: { percent?: number }) {
        const pressure = this.getPressureStatus(_sessionId, usage) as {
          level: "low" | "high" | "critical";
          usageRatio: number;
          hardLimitRatio: number;
          compactionThresholdRatio: number;
        };
        return {
          required: pressure.level === "critical",
          reason: pressure.level === "critical" ? "hard_limit" : null,
          pressure,
          recentCompaction: false,
          windowTurns: 2,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        };
      },
      getPendingCompactionReason(_sessionId: string, usage?: { percent?: number }) {
        const pressure = this.getPressureStatus(_sessionId, usage) as {
          level: "low" | "high" | "critical";
        };
        return pressure.level === "critical" ? "hard_limit" : null;
      },
    });
    await createHostedTurnPipeline({
      runtime,
      registerTools: false,
    }).register(api);

    await invokeHandlersAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue task",
        systemPrompt: "base prompt",
      },
      createSessionContext(sessionId),
    );

    sessionUsage = {
      tokens: 88_000,
      contextWindow: 100_000,
      percent: 0.88,
    };
    runtime.maintain.context.observeUsage(sessionId, sessionUsage);
    const reducedPayload = invokeBeforeProviderRequestChain(
      handlers,
      {
        model: "gpt-5.4",
        messages: Array.from({ length: 6 }, (_, index) => ({
          role: "tool",
          tool_call_id: `call-${index + 1}`,
          name: "read",
          content: `${"x".repeat(512)}:${index + 1}`,
        })),
      },
      sessionId,
    );

    expect((reducedPayload.messages as Array<Record<string, unknown>>)[0]?.content).toBe(
      "[cleared_for_request]",
    );

    invokeHandlers(
      handlers,
      "message_end",
      {
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5.4",
          stopReason: "end_turn",
          usage: {
            input: 18,
            output: 6,
            cacheRead: 40,
            cacheWrite: 9,
            totalTokens: 73,
            cost: {
              total: 0.0002,
            },
          },
          content: [{ type: "text", text: "cached response" }],
        },
      },
      createSessionContext(sessionId),
    );

    const report = buildContextEvidenceReport(runtime, {
      sessionIds: [sessionId],
    });

    expect(report.aggregate).toMatchObject({
      sessionsObserved: 1,
      promptObservedTurns: 1,
      stablePrefixTurns: 1,
      reductionObservedTurns: 1,
      reductionCompletedTurns: 1,
      totalCacheReadTokens: 40,
      totalCacheWriteTokens: 9,
      sessionsWithObservedCacheAccounting: 1,
      sessionsWithCompletedReductionAndNoCompaction: 1,
    });
    expect(report.promotionReadiness).toEqual({
      stablePrefixTargetMet: true,
      reductionEvidenceObserved: true,
      cacheAccountingObserved: true,
      ready: true,
      gaps: [],
    });
    expect(report.sessions).toEqual([
      expect.objectContaining({
        sessionId,
        cacheReadReported: true,
        cacheWriteReported: true,
        cacheAccountingObserved: true,
        reductionCompletedTurns: 1,
        stablePrefixRate: 1,
      }),
    ]);
  });
});
