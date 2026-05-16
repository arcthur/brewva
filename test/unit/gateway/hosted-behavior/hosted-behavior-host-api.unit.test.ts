import { describe, expect, test } from "bun:test";
import { ROLLBACK_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import {
  buildContextEvidenceReport,
  createHostedBehaviorHostAdapter,
  type LocalHookPort,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import {
  createMockExtensionApi,
  invokeHandlerAsync,
  invokeHandlersAsync,
  invokeHandlers,
} from "../../../helpers/extension.js";
import {
  createRuntimeConfig,
  createRuntimeFixture as createBaseRuntimeFixture,
} from "../../../helpers/runtime.js";

interface RuntimeCalls {
  started: Array<Record<string, unknown>>;
  finished: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  cleared: string[];
  observedContext: Array<{ sessionId: string; usage: unknown }>;
}

function makeContextStatus(
  usageRatio: number,
  hardLimitRatio = 0.98,
  compactionThresholdRatio = 0.8,
) {
  const tokensTotal = 4096;
  const tokensUsed = Math.round(tokensTotal * usageRatio);
  const hardLimitTokens = Math.floor(tokensTotal * hardLimitRatio);
  return {
    tokensUsed,
    tokensTotal,
    tokensRemaining: Math.max(0, tokensTotal - tokensUsed),
    tokensUntilForcedCompact: Math.max(0, hardLimitTokens - tokensUsed),
    predictedTurnGrowthTokens: 1024,
    tokensUntilPredictedOverflow: Math.max(0, hardLimitTokens - 1024 - tokensUsed),
    predictedOverflow: tokensUsed + 1024 >= hardLimitTokens,
    usageRatio,
    hardLimitRatio,
    compactionThresholdRatio,
    compactionAdvised: usageRatio >= compactionThresholdRatio,
    forcedCompaction: usageRatio >= hardLimitRatio,
  };
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
      config.infrastructure.events.level = "debug";
      config.infrastructure.contextBudget.compaction.tailProtectTokens = 0;
    }),
  });
  const rawEventQuery = runtime.inspect.events.records.query.bind(runtime.inspect.events.records);
  const rawEventQueryStructured = runtime.inspect.events.records.queryStructured.bind(
    runtime.inspect.events.records,
  );

  Object.assign(runtime.authority.tools.invocation, {
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

  Object.assign(runtime.inspect.tools.access, {
    explain() {
      return { allowed: true };
    },
  });

  Object.assign(runtime.operator.context.usage, {
    observe(sessionId: string, usage: unknown) {
      calls.observedContext.push({ sessionId, usage });
    },
  });

  Object.assign(runtime.inspect.context.usage, {
    get() {
      return { tokens: 320, contextWindow: 4096, percent: 0.078 };
    },
    getStatus(_sessionId: string, usage?: { percent?: number }) {
      return makeContextStatus(typeof usage?.percent === "number" ? usage.percent : 0.078);
    },
  });

  Object.assign(runtime.inspect.context.compaction, {
    getGateStatus() {
      return {
        required: true,
        status: makeContextStatus(0.99),
        recentCompaction: false,
        windowTurns: 2,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
      };
    },
    getThresholdRatio() {
      return 0.8;
    },
    getPendingReason() {
      return "hard_limit";
    },
    getHardLimitRatio() {
      return 0.98;
    },
  });

  Object.assign(runtime.inspect.context, {
    sanitizeInput(text: string) {
      return text;
    },
  });

  runtime.inspect.events.records.subscribe((event) => {
    calls.events.push(event as unknown as Record<string, unknown>);
  });

  Object.assign(runtime.inspect.events.records, {
    query() {
      return [];
    },
    queryStructured() {
      return [];
    },
  });

  Object.assign(runtime.inspect.tape.status, {
    get() {
      return {
        tapePressure: "medium",
        totalEntries: 42,
        entriesSinceAnchor: 7,
        entriesSinceCheckpoint: 4,
        lastAnchor: { id: "anchor-1", name: "phase-alpha" },
        thresholds: { low: 5, medium: 20, high: 50 },
      };
    },
    getPressureThresholds() {
      return { low: 5, medium: 20, high: 50 };
    },
  });

  Object.assign(runtime.inspect.task.state, {
    get() {
      return {
        spec: {
          goal: "Stabilize hosted behavior behavior.",
        },
        status: {
          phase: "execute",
        },
        items: [],
        blockers: [],
      };
    },
  });

  Object.assign(runtime.inspect.skills.catalog, {
    get() {
      return undefined;
    },
  });

  Object.assign(runtime.operator.session.state, {
    clear(sessionId: string) {
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

describe("hosted behavior host-api installation", () => {
  test("registers the canonical hosted handlers", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime } = createRuntimeFixture();
    await createHostedBehaviorHostAdapter({
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

  test("composes context through before_agent_start on the canonical hosted behavior", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedBehaviorHostAdapter({
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

  test("throttles repeated compaction nudges without hiding the action", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime } = createRuntimeFixture();
    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
    }).register(api);

    const firstResults = await invokeHandlersAsync<{
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue task",
        systemPrompt: "base prompt",
      },
      createSessionContext("hosted-nudge-throttle"),
    );
    const secondResults = await invokeHandlersAsync<{
      message?: { content?: string };
    }>(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "continue task again",
        systemPrompt: "base prompt",
      },
      createSessionContext("hosted-nudge-throttle"),
    );

    const firstContent = firstResults.find((result) => result?.message?.content)?.message?.content;
    const secondContent = secondResults.find((result) => result?.message?.content)?.message
      ?.content;
    expect(firstContent).toContain("Context has reached the forced compaction limit.");
    expect(secondContent).toContain("[ContextCompactionGate]");
    expect(secondContent).toContain("action: call `workbench_compact` now.");
    expect(secondContent).not.toContain("Context has reached the forced compaction limit.");
  });

  test("runs local pre_admission hooks before hosted tool-surface resolution", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const seenInputs: string[] = [];
    const localHook: LocalHookPort = {
      name: "local-pre-admission-recommendation",
      preAdmission(input) {
        seenInputs.push(`${input.phase}:${input.sessionId}:${input.prompt}`);
        return {
          kind: "recommend",
          recommendations: [
            {
              message: "Treat this as repository analysis.",
            },
          ],
        };
      },
    };

    await createHostedBehaviorHostAdapter({
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
      "pre_admission:hosted-local-hook-classify:Analyze repository boundaries before changing code.",
    ]);

    const governanceIndex = calls.events.findIndex((event) => {
      const payload = readEventPayload(event);
      return event.type === "turn_governance_decision" && payload.phase === "pre_admission";
    });
    const toolSurfaceIndex = calls.events.findIndex(
      (event) => event.type === "tool_surface_resolved",
    );

    expect(governanceIndex).toBeGreaterThanOrEqual(0);
    expect(toolSurfaceIndex).toBeGreaterThan(governanceIndex);
  });

  test("routes tool_call blocking through the hosted behavior quality gate", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture({
      startAllowed: false,
      startReason: "blocked-by-runtime",
    });
    await createHostedBehaviorHostAdapter({
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

  test("local pre_effect blocks narrow execution before runtime authority starts", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const localHook: LocalHookPort = {
      name: "local-tool-blocker",
      preEffect(input) {
        expect(input.phase).toBe("pre_effect");
        expect(input.toolName).toBe("exec");
        return {
          kind: "block_tool",
          reason: "local policy denies exec",
        };
      },
    };

    await createHostedBehaviorHostAdapter({
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
          payload.phase === "pre_effect" &&
          payload.hookName === "local-tool-blocker"
        );
      }),
    ).toBe(true);
  });

  test("runs canonical local preEffect hooks without deprecated alias fallback", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const localHook: LocalHookPort = {
      name: "local-pre-effect-blocker",
      preEffect(input) {
        expect(input.phase).toBe("pre_effect");
        return {
          kind: "block_tool",
          reason: "canonical local policy denies exec",
        };
      },
    };

    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    let result: { block?: boolean; reason?: string } | undefined;
    for (const handler of handlers.get("tool_call") ?? []) {
      result = (await handler(
        {
          type: "tool_call",
          toolCallId: "tool-call-canonical-local-block",
          toolName: "exec",
          input: { command: "pwd" },
        },
        createSessionContext("hosted-canonical-local-hook-tool"),
      )) as { block?: boolean; reason?: string } | undefined;
      if (result?.block) {
        break;
      }
    }

    expect(result).toEqual({
      block: true,
      reason: "canonical local policy denies exec",
    });
    expect(calls.started).toHaveLength(0);
  });

  test("local post_receipt recommendations do not rewrite normalized tool results", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime } = createRuntimeFixture();
    const observed: Array<{
      contentText: string | undefined;
      detailValue: string | undefined;
    }> = [];
    const localHook: LocalHookPort = {
      name: "local-post-receipt-observer",
      postReceipt(input) {
        expect(input.phase).toBe("post_receipt");
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

    await createHostedBehaviorHostAdapter({
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
      createSessionContext("hosted-local-hook-post-receipt"),
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

  test("runs local post_rollback hooks from runtime rollback receipts", async () => {
    const { api } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const observed: string[] = [];
    const localHook: LocalHookPort = {
      name: "local-rollback-observer",
      postRollback(input) {
        observed.push(`${input.phase}:${input.sessionId}:${input.reason}`);
        return {
          kind: "observe",
          notes: [{ message: "Rollback observed." }],
        };
      },
    };

    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    runtime.extensions.hosted.events.record({
      sessionId: "hosted-local-hook-rollback",
      type: ROLLBACK_EVENT_TYPE,
      payload: {
        ok: true,
        reason: "manual_rollback",
      },
    });
    await Promise.resolve();

    expect(observed).toEqual(["post_rollback:hosted-local-hook-rollback:manual_rollback"]);
    expect(
      calls.events.some((event) => {
        const payload = readEventPayload(event);
        return (
          event.type === "turn_governance_decision" &&
          payload.phase === "post_rollback" &&
          payload.hookName === "local-rollback-observer"
        );
      }),
    ).toBe(true);
  });

  test("unbinds local post_rollback event subscription when the session ends", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime } = createRuntimeFixture();
    const observed: string[] = [];
    const localHook: LocalHookPort = {
      name: "local-rollback-lifecycle-observer",
      postRollback(input) {
        observed.push(`${input.sessionId}:${input.reason}`);
        return { kind: "observe" };
      },
    };

    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    await invokeHandlersAsync(
      handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "start session",
        systemPrompt: "base prompt",
      },
      createSessionContext("hosted-local-hook-dispose"),
    );
    runtime.extensions.hosted.events.record({
      sessionId: "hosted-local-hook-dispose",
      type: ROLLBACK_EVENT_TYPE,
      payload: {
        ok: true,
        reason: "before_shutdown",
      },
    });
    await Promise.resolve();

    await invokeHandlersAsync(
      handlers,
      "session_shutdown",
      { type: "session_shutdown" },
      createSessionContext("hosted-local-hook-dispose"),
    );
    runtime.extensions.hosted.events.record({
      sessionId: "hosted-local-hook-dispose",
      type: ROLLBACK_EVENT_TYPE,
      payload: {
        ok: true,
        reason: "after_shutdown",
      },
    });
    await Promise.resolve();

    expect(observed).toEqual(["hosted-local-hook-dispose:before_shutdown"]);
  });

  test("isolates local post_rollback hook failures as governance receipts", async () => {
    const { api } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const localHook: LocalHookPort = {
      name: "local-rollback-failing-observer",
      postRollback() {
        throw new Error("rollback observer failed");
      },
    };

    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    runtime.extensions.hosted.events.record({
      sessionId: "hosted-local-hook-rollback-failure",
      type: ROLLBACK_EVENT_TYPE,
      payload: {
        ok: true,
        reason: "manual_rollback",
      },
    });
    await Promise.resolve();

    expect(
      calls.events.some((event) => {
        const payload = readEventPayload(event);
        const result =
          payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
            ? (payload.result as Record<string, unknown>)
            : {};
        const notes = Array.isArray(result.notes) ? result.notes : [];
        const firstNote =
          notes[0] && typeof notes[0] === "object" && !Array.isArray(notes[0])
            ? (notes[0] as Record<string, unknown>)
            : {};
        return (
          event.type === "turn_governance_decision" &&
          payload.phase === "post_rollback" &&
          payload.hookName === "local-rollback-failing-observer" &&
          result.kind === "observe" &&
          firstNote.severity === "error"
        );
      }),
    ).toBe(true);
  });

  test("downgrades local post_rollback block attempts to advisory receipts", async () => {
    const { api } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    const localHook: LocalHookPort = {
      name: "local-rollback-block-attempt",
      postRollback() {
        return {
          kind: "block_tool",
          reason: "rollback observer cannot block",
        } as never;
      },
    };

    await createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
      localHooks: [localHook],
    }).register(api);

    runtime.extensions.hosted.events.record({
      sessionId: "hosted-local-hook-rollback-block-attempt",
      type: ROLLBACK_EVENT_TYPE,
      payload: {
        ok: true,
        reason: "manual_rollback",
      },
    });
    await Promise.resolve();

    const governanceEvent = calls.events.find((event) => {
      const payload = readEventPayload(event);
      return (
        event.type === "turn_governance_decision" &&
        payload.phase === "post_rollback" &&
        payload.hookName === "local-rollback-block-attempt"
      );
    });
    const payload = readEventPayload(governanceEvent ?? {});
    const result =
      payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
        ? (payload.result as Record<string, unknown>)
        : {};
    const notes = Array.isArray(result.notes) ? result.notes : [];

    expect(result.kind).toBe("observe");
    expect(
      notes.some((note) => {
        if (!note || typeof note !== "object" || Array.isArray(note)) {
          return false;
        }
        return String((note as Record<string, unknown>).message).includes(
          "only pre_effect hooks may block tool execution",
        );
      }),
    ).toBe(true);
  });

  test("uses tool_execution_end only as fallback finalize source", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedBehaviorHostAdapter({
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

  test("cleans runtime session state on hosted behavior shutdown", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, calls } = createRuntimeFixture();
    await createHostedBehaviorHostAdapter({
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

  test("routes prompt stability, transient reduction, and message usage through the canonical hosted behavior into context evidence readiness", async () => {
    const { api, handlers } = createMockExtensionApi();
    const { runtime, rawEventQuery, rawEventQueryStructured } = createRuntimeFixture();
    const sessionId = "hosted-context-evidence-ready";
    let sessionUsage = { tokens: 320, contextWindow: 4096, percent: 0.078 };
    Object.assign(runtime.inspect.events.records, {
      query: rawEventQuery,
      queryStructured: rawEventQueryStructured,
    });
    Object.assign(runtime.inspect.context.usage, {
      get(requestedSessionId?: string) {
        if (requestedSessionId === sessionId) {
          return sessionUsage;
        }
        return { tokens: 320, contextWindow: 4096, percent: 0.078 };
      },
      getStatus(_sessionId: string, usage?: { percent?: number }) {
        const usageRatio = typeof usage?.percent === "number" ? usage.percent : 0;
        return makeContextStatus(usageRatio);
      },
    });
    Object.assign(runtime.inspect.context.compaction, {
      getGateStatus(_sessionId: string, usage?: { percent?: number }) {
        const status = makeContextStatus(typeof usage?.percent === "number" ? usage.percent : 0);
        return {
          required: status.forcedCompaction,
          reason: status.forcedCompaction ? "hard_limit" : null,
          status,
          recentCompaction: false,
          windowTurns: 2,
          lastCompactionTurn: null,
          turnsSinceCompaction: null,
        };
      },
      getPendingReason(_sessionId: string, usage?: { percent?: number }) {
        const status = makeContextStatus(typeof usage?.percent === "number" ? usage.percent : 0);
        return status.forcedCompaction ? "hard_limit" : null;
      },
    });
    await createHostedBehaviorHostAdapter({
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
    runtime.operator.context.usage.observe(sessionId, sessionUsage);
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
      promptCacheHitTargetMet: true,
      promptCacheStopLossPassed: true,
      inputCostBaselineObserved: false,
      inputCostStopLossPassed: true,
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
