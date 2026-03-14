import { describe, expect, test } from "bun:test";
import {
  createMockExtensionAPI,
  createRuntimeConfig,
  createRuntimeFixture,
  invokeHandler,
  registerContextTransform,
} from "./context-transform.helpers.js";

describe("context transform compaction contract", () => {
  test("records context_compaction_skipped in non-interactive mode", () => {
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
          entries: [],
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

  test("triggers one auto compaction at a time until completion in interactive mode", () => {
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
          entries: [],
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

  test("skips manual compact when the agent is still active", () => {
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
          entries: [],
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

  test("fails closed when interactive mode lacks an idle probe", () => {
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
          entries: [],
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

  test("deduplicates repeated skip events for the same active compaction condition", () => {
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
          entries: [],
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

  test("clears the in-flight lock when the auto-compaction watchdog fires", async () => {
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
          entries: [],
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
});
