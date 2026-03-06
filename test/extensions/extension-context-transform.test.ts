import { describe, expect, test } from "bun:test";
import { createBrewvaExtension, registerContextTransform } from "@brewva/brewva-extensions";
import { createMockExtensionAPI, invokeHandler, invokeHandlerAsync } from "../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "./fixtures/runtime.js";

describe("Extension gaps: context transform", () => {
  test("given context transform registration, when before_agent_start runs, then hidden context message is injected", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "[Brewva Context]\nTop-K Skill Candidates:\n- debugging",
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
    expect(result.message.content.includes("[Brewva Context]")).toBe(true);
    expect(result.message.content.includes("debugging")).toBe(true);
    expect(result.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
  });

  test("given injection rejected by budget, when before_agent_start runs, then only tape status context is emitted", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => false,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
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

    expect(result.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(result.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(result.message?.content?.includes("[Brewva Context]")).toBe(false);
  });

  test("given pending non-critical compaction, when before_agent_start runs, then advisory is injected without arming gate", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];
    const advisoryPayloads: Record<string, unknown>[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: Record<string, unknown> }) => {
          eventTypes.push(input.type);
          if (input.type === "context_compaction_advisory" && input.payload) {
            advisoryPayloads.push(input.payload);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionId = "s-pending-compaction-advisory";
    runtime.context.observeUsage(sessionId, {
      tokens: 850,
      contextWindow: 1000,
      percent: 0.85,
    });
    runtime.context.requestCompaction(sessionId, "usage_threshold");

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

    expect(result.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(result.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(result.message?.content?.includes("pending_compaction_reason: usage_threshold")).toBe(
      true,
    );
    expect(result.message?.content?.includes("required_action: session_compact_recommended")).toBe(
      true,
    );
    expect(result.message?.content?.includes("[ContextCompactionAdvisory]")).toBe(true);
    expect(result.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).toContain("context_compaction_advisory");
    expect(advisoryPayloads).toHaveLength(1);
    expect(advisoryPayloads[0]?.reason).toBe("usage_threshold");
    expect(advisoryPayloads[0]?.requiredTool).toBe("session_compact");
    expect(advisoryPayloads[0]?.contextPressure).toBe("high");
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
    expect(eventTypes).not.toContain("critical_without_compact");
  });

  test("given session leaf id, when building context injection, then runtime receives leaf scope id", async () => {
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

  test("given async runtime.context.buildInjection, when before_agent_start runs, then async injection result is used", async () => {
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
            text: "[async]",
            accepted: true,
            originalTokens: 2,
            finalTokens: 2,
            truncated: false,
          };
        },
      },
    });

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
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

    expect(calls).toEqual(["async"]);
    expect(result.message.content.includes("[async]")).toBe(true);
  });

  test("given deterministic runtime routing, when before_agent_start runs, then extension emits real routing telemetry", async () => {
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
    const result = await invokeHandlerAsync<{
      message: {
        details?: {
          routingTranslation?: {
            status?: string;
            reason?: string;
            translated?: boolean;
          };
          semanticRouting?: {
            status?: string;
            reason?: string;
            selectedCount?: number;
          };
        };
      };
    }>(
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

    const translationPayload = runtime.events.query(sessionId, {
      type: "skill_routing_translation",
      last: 1,
    })[0]?.payload as { status?: string; reason?: string; translated?: boolean } | undefined;
    const semanticPayload = runtime.events.query(sessionId, {
      type: "skill_routing_semantic",
      last: 1,
    })[0]?.payload as { status?: string; reason?: string; selectedCount?: number } | undefined;

    expect(translationPayload?.status).toBe("skipped");
    expect(translationPayload?.reason).toBe("deterministic_router");
    expect(translationPayload?.translated).toBe(false);
    expect(semanticPayload?.status).toBe("selected");
    expect(semanticPayload?.reason).toBe("deterministic_router_selected");
    expect((semanticPayload?.selectedCount ?? 0) > 0).toBe(true);
    expect(result.message.details?.routingTranslation?.status).toBe("skipped");
    expect(result.message.details?.routingTranslation?.reason).toBe("deterministic_router");
    expect(result.message.details?.routingTranslation?.translated).toBe(false);
    expect(result.message.details?.semanticRouting?.status).toBe("selected");
    expect(result.message.details?.semanticRouting?.reason).toBe("deterministic_router_selected");
    expect((result.message.details?.semanticRouting?.selectedCount ?? 0) > 0).toBe(true);
    expect(runtime.skills.clearNextSelection(sessionId)).toBeUndefined();

    const summary = runtime.cost.getSummary(sessionId);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
  });

  test("given createBrewvaExtension factory, when initialized with runtime, then async context injection is preserved", async () => {
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
            text: "[async]",
            accepted: true,
            originalTokens: 2,
            finalTokens: 2,
            truncated: false,
          };
        },
      },
    });

    const extension = createBrewvaExtension({
      runtime,
      registerTools: false,
    });
    await extension(api);

    const result = await invokeHandlerAsync<{
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

    expect(calls).toEqual(["async"]);
    expect(result.message.content.includes("[async]")).toBe(true);
  });

  test("given non-interactive mode and compaction requested, when context hook runs, then context_compaction_skipped is recorded", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 1 },
      { sessionManager: { getSessionId: () => "s-print" } },
    );
    invokeHandler(
      handlers,
      "context",
      {},
      {
        hasUI: false,
        sessionManager: {
          getSessionId: () => "s-print",
        },
        getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
      },
    );

    expect(skippedReasons).toContain("non_interactive_mode");
  });

  test("given interactive mode and compaction requested, when context hook runs, then auto compaction is triggered once until completion", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const autoRequestedReasons: string[] = [];
    const autoCompletedReasons: string[] = [];
    const compactOptions: Array<{
      customInstructions?: string;
      onComplete?: () => void;
      onError?: (error: Error) => void;
    }> = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.compactionInstructions = "compact-only-active-state";
      }),
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          if (input.type === "context_compaction_auto_requested" && input.payload?.reason) {
            autoRequestedReasons.push(input.payload.reason);
          }
          if (input.type === "context_compaction_auto_completed" && input.payload?.reason) {
            autoCompletedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-ui-auto-compact",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 3 },
      {
        sessionManager,
      },
    );

    const interactiveContext = {
      hasUI: true,
      isIdle: () => true,
      compact: (options?: {
        customInstructions?: string;
        onComplete?: () => void;
        onError?: (error: Error) => void;
      }) => {
        compactOptions.push(options ?? {});
      },
      sessionManager,
      getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
    };

    invokeHandler(handlers, "context", {}, interactiveContext);
    invokeHandler(handlers, "context", {}, interactiveContext);

    expect(compactOptions).toHaveLength(1);
    expect(compactOptions[0]?.customInstructions).toBe("compact-only-active-state");
    expect(skippedReasons).toContain("auto_compaction_in_flight");
    expect(autoRequestedReasons).toContain("usage_threshold");

    compactOptions[0]?.onComplete?.();
    expect(autoCompletedReasons).toContain("usage_threshold");

    invokeHandler(handlers, "context", {}, interactiveContext);
    expect(compactOptions).toHaveLength(2);
  });

  test("given interactive mode and active agent run, when context hook requests compaction, then manual compact is skipped", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const autoRequestedReasons: string[] = [];
    const compactCalls: Array<Record<string, unknown>> = [];

    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          if (input.type === "context_compaction_auto_requested" && input.payload?.reason) {
            autoRequestedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-ui-busy-compact",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 7 },
      {
        sessionManager,
      },
    );

    invokeHandler(
      handlers,
      "context",
      {},
      {
        hasUI: true,
        isIdle: () => false,
        compact: (options?: Record<string, unknown>) => {
          compactCalls.push(options ?? {});
        },
        sessionManager,
        getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
      },
    );

    expect(compactCalls).toHaveLength(0);
    expect(autoRequestedReasons).toHaveLength(0);
    expect(skippedReasons).toContain("agent_active_manual_compaction_unsafe");
  });

  test("given interactive mode without idle probe, when context hook requests compaction, then manual compact is skipped fail-closed", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];
    const autoRequestedReasons: string[] = [];
    const compactCalls: Array<Record<string, unknown>> = [];

    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          if (input.type === "context_compaction_auto_requested" && input.payload?.reason) {
            autoRequestedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-ui-missing-idle-probe",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 9 },
      {
        sessionManager,
      },
    );

    invokeHandler(
      handlers,
      "context",
      {},
      {
        hasUI: true,
        compact: (options?: Record<string, unknown>) => {
          compactCalls.push(options ?? {});
        },
        sessionManager,
        getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
      },
    );

    expect(compactCalls).toHaveLength(0);
    expect(autoRequestedReasons).toHaveLength(0);
    expect(skippedReasons).toContain("agent_active_manual_compaction_unsafe");
  });

  test("given interactive mode and active agent run, when context hook repeats same pending compaction, then skip event is deduplicated", () => {
    const { api, handlers } = createMockExtensionAPI();
    const skippedReasons: string[] = [];

    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { reason?: string } }) => {
          if (input.type === "context_compaction_skipped" && input.payload?.reason) {
            skippedReasons.push(input.payload.reason);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime);

    const sessionManager = {
      getSessionId: () => "s-ui-busy-compact-dedupe",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 8 },
      {
        sessionManager,
      },
    );

    const busyContext = {
      hasUI: true,
      isIdle: () => false,
      compact: () => {
        throw new Error("compact should not be called while agent is active");
      },
      sessionManager,
      getContextUsage: () => ({ tokens: 995, contextWindow: 1000, percent: 0.995 }),
    };

    invokeHandler(handlers, "context", {}, busyContext);
    invokeHandler(handlers, "context", {}, busyContext);

    expect(skippedReasons).toEqual(["agent_active_manual_compaction_unsafe"]);
  });

  test("given interactive mode and missing compact callbacks, when watchdog expires, then in-flight lock is cleared and next context retries", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const autoFailedErrors: string[] = [];
    const compactCalls: Array<Record<string, unknown>> = [];

    const runtime = createRuntimeFixture({
      context: {
        onTurnStart: () => undefined,
        observeUsage: () => undefined,
        checkAndRequestCompaction: () => true,
        getPendingCompactionReason: () => "usage_threshold",
        markCompacted: () => undefined,
        buildInjection: async () => ({
          text: "",
          accepted: false,
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
        }),
      },
      events: {
        record: (input: { type: string; payload?: { error?: string } }) => {
          if (input.type === "context_compaction_auto_failed" && input.payload?.error) {
            autoFailedErrors.push(input.payload.error);
          }
          return undefined;
        },
      },
    });

    registerContextTransform(api, runtime, {
      autoCompactionWatchdogMs: 1,
    });

    const sessionManager = {
      getSessionId: () => "s-ui-watchdog-recovery",
    };

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 5 },
      {
        sessionManager,
      },
    );

    const interactiveContext = {
      hasUI: true,
      isIdle: () => true,
      compact: (options?: Record<string, unknown>) => {
        compactCalls.push(options ?? {});
      },
      sessionManager,
      getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 0.99 }),
    };

    invokeHandler(handlers, "context", {}, interactiveContext);
    expect(compactCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(autoFailedErrors).toContain("auto_compaction_watchdog_timeout");

    invokeHandler(handlers, "context", {}, interactiveContext);
    expect(compactCalls).toHaveLength(2);
  });

  test("given critical gate required, when before_agent_start runs, then routing and injection are short-circuited", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventPayloads: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    let injectionCalls = 0;

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.hardLimitPercent = 0.8;
      }),
      context: {
        buildInjection: async () => {
          injectionCalls += 1;
          return {
            text: "[should-not-run]",
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

    runtime.skills.setNextSelection(
      "s-critical-short-circuit",
      [
        {
          name: "review",
          score: 20,
          reason: "semantic:stale",
          breakdown: [{ signal: "semantic_match", term: "stale", delta: 20 }],
        },
      ],
      { routingOutcome: "selected" },
    );

    registerContextTransform(api, runtime);

    const result = await invokeHandlerAsync<{
      message?: {
        content?: string;
        details?: {
          routingTranslation?: { status?: string; reason?: string };
          semanticRouting?: { status?: string; reason?: string; selectedCount?: number };
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
    expect(result.message?.content?.includes("[ContextCompactionGate]")).toBe(true);
    expect(result.message?.details?.routingTranslation?.status).toBe("skipped");
    expect(result.message?.details?.routingTranslation?.reason).toBe("critical_compaction_gate");
    expect(result.message?.details?.semanticRouting?.status).toBe("skipped");
    expect(result.message?.details?.semanticRouting?.selectedCount).toBe(0);
    expect(runtime.skills.clearNextSelection("s-critical-short-circuit")).toBeUndefined();

    const translationEvent = eventPayloads.find(
      (event) => event.type === "skill_routing_translation",
    );
    expect(translationEvent?.payload?.status).toBe("skipped");
    expect(translationEvent?.payload?.reason).toBe("critical_compaction_gate");
  });

  test("given critical context pressure, when gating lifecycle runs, then non-session_compact flow is gated and clears after compaction", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];
    const capturedCompactions: Array<Record<string, unknown>> = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.hardLimitPercent = 0.8;
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

    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("tape_pressure:")).toBe(true);
    expect(before.message?.content?.includes("required_action: session_compact_now")).toBe(true);
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
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

  test("given recent compaction, when critical usage appears, then gate is not armed", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.hardLimitPercent = 0.8;
      }),
      context: {
        buildInjection: async () => ({
          text: "",
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

    invokeHandler(
      handlers,
      "turn_start",
      { turnIndex: 3 },
      {
        sessionManager,
      },
    );

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

    expect(before.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });

  test("given compaction within window turns, when critical usage appears, then gate stays disarmed until window expires", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.hardLimitPercent = 0.8;
      }),
      context: {
        buildInjection: async () => ({
          text: "",
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
    expect(withinWindow.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(withinWindow.message?.content?.includes("[TapeStatus]")).toBe(true);
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
    expect(afterWindow.message?.content?.includes("[ContextCompactionGate]")).toBe(true);
    expect(afterWindow.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(afterWindow.message?.content?.includes("tape_pressure:")).toBe(true);
    expect(eventTypes).toContain("context_compaction_gate_armed");
    expect(eventTypes).toContain("critical_without_compact");
  });

  test("given previously compacted runtime state, when high pressure starts, then gate remains disarmed", async () => {
    const { api, handlers } = createMockExtensionAPI();
    const eventTypes: string[] = [];

    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.infrastructure.contextBudget.hardLimitPercent = 0.8;
      }),
      context: {
        buildInjection: async () => ({
          text: "",
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

    expect(before.systemPrompt?.includes("[Brewva Context Contract]")).toBe(true);
    expect(before.message?.content?.includes("[TapeStatus]")).toBe(true);
    expect(before.message?.content?.includes("[ContextCompactionGate]")).toBe(false);
    expect(eventTypes).not.toContain("context_compaction_gate_armed");
  });
});
