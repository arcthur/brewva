import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionBackendStateError } from "@brewva/brewva-gateway";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import {
  createInMemoryModelCatalog,
  type BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import { createHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  createBrewvaTurnLoopController,
  type BrewvaTurnEventScope,
  type BrewvaTurnLoopAssistantMessage,
  type BrewvaTurnLoopAssistantMessageStream,
  type BrewvaTurnLoopAssistantMessageEvent,
  type BrewvaTurnLoopEvent,
  type BrewvaTurnLoopLlmMessage,
  type BrewvaTurnLoopStreamFunction,
  type BrewvaTurnLoopToolResultMessage,
} from "@brewva/brewva-substrate/turn";
import { Type } from "@sinclair/typebox";
import { createChannelControlRouter } from "../../../packages/brewva-gateway/src/channels/command/router.js";
import { createChannelUpdateLockManager } from "../../../packages/brewva-gateway/src/channels/session/update-lock.js";
import { createHostedBehaviorHostAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { createBrewvaManagedAgentSession } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import { registerFauxProvider } from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import {
  createConnectionState,
  createDaemonHarness,
  createSessionBackendStub,
  getHandleMethod,
} from "../../contract/gateway/gateway-control-plane.helpers.js";
import { requireDefined } from "../../helpers/assertions.js";
import { createTurnEventStream, createTurnStreamFromPromise } from "../../helpers/effect-stream.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

const TEST_MODEL: BrewvaRegisteredModel = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

function createUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createAssistantMessage(
  content: BrewvaTurnLoopAssistantMessage["content"],
  stopReason: BrewvaTurnLoopAssistantMessage["stopReason"] = "stop",
): BrewvaTurnLoopAssistantMessage {
  return {
    role: "assistant",
    content,
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: createUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function createStream(
  finalMessage: BrewvaTurnLoopAssistantMessage,
  events: BrewvaTurnLoopAssistantMessageEvent[] = [],
): BrewvaTurnLoopAssistantMessageStream {
  const allEvents = [...events];
  if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
    allEvents.push({
      type: "error",
      reason: finalMessage.stopReason,
      error: finalMessage,
    });
  } else {
    allEvents.push({
      type: "done",
      reason: finalMessage.stopReason,
      message: finalMessage,
    });
  }

  return createTurnEventStream(allEvents);
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEngine(
  streamFn: BrewvaTurnLoopStreamFunction,
  options?: {
    afterToolCall?: Parameters<typeof createBrewvaTurnLoopController>[0]["afterToolCall"];
  },
) {
  return createBrewvaTurnLoopController({
    initialModel: TEST_MODEL,
    initialThinkingLevel: "off",
    sessionId: "steer-test-session",
    queueMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    transport: "sse",
    thinkingBudgets: undefined,
    maxRetryDelayMs: 1000,
    beforeToolCall: async () => undefined,
    afterToolCall: options?.afterToolCall ?? (async () => undefined),
    onPayload: async (payload) => payload,
    transformContext: async (messages) => messages,
    resolveRequestAuth: async () => ({ ok: true, apiKey: "test-key" }),
    streamFn,
  });
}

function createUserPrompt(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function findToolResultMessages(events: BrewvaTurnLoopEvent[]): BrewvaTurnLoopToolResultMessage[] {
  const results: BrewvaTurnLoopToolResultMessage[] = [];
  for (const event of events) {
    if (event.type === "message_end" && event.message.role === "toolResult") {
      results.push(event.message);
    }
  }
  return results;
}

function createSettingsStub() {
  return {
    getQuietStartup() {
      return true;
    },
    getQueueMode() {
      return "one-at-a-time" as const;
    },
    getFollowUpMode() {
      return "one-at-a-time" as const;
    },
    getTransport() {
      return "sse" as const;
    },
    getCachePolicy() {
      return {
        retention: "short" as const,
        writeMode: "readWrite" as const,
        scope: "session" as const,
        reason: "default" as const,
      };
    },
    getThinkingBudgets() {
      return undefined;
    },
    getRetrySettings() {
      return undefined;
    },
    setDefaultThinkingLevel() {},
    getModelPreferences() {
      return { recent: [], favorite: [] };
    },
    setModelPreferences() {},
    getDiffPreferences() {
      return { style: "auto" as const, wrapMode: "word" as const };
    },
    setDiffPreferences() {},
    getShellViewPreferences() {
      return { showThinking: true, toolDetails: true };
    },
    setShellViewPreferences() {},
  };
}

function registerModel(
  modelCatalog: ReturnType<typeof createInMemoryModelCatalog>,
  model: BrewvaRegisteredModel,
): void {
  modelCatalog.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "test-key",
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
}

async function createManagedSessionFixture(
  testName: string,
  options?: { customTools?: BrewvaToolDefinition[] },
) {
  const workspace = createTestWorkspace(testName);
  const runtime = createHostedTestRuntime({ cwd: workspace });
  const sessionStore = new HostedRuntimeTapeSessionStore(runtime, `${testName}-session`);
  const fauxProvider = registerFauxProvider({
    api: `${testName}-faux`,
    provider: `${testName}-provider`,
    models: [
      {
        id: `${testName}-model`,
        name: `Model ${testName}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
  const model = fauxProvider.getModel();
  const modelCatalog = createInMemoryModelCatalog();
  registerModel(modelCatalog, model);
  sessionStore.appendModelChange(model.provider, model.id);
  sessionStore.appendThinkingLevelChange("off");

  const session = await createBrewvaManagedAgentSession({
    cwd: workspace,
    agentDir: join(workspace, ".brewva-agent"),
    sessionStore,
    settings: createSettingsStub(),
    runtime,
    modelCatalog,
    resourceLoader: await createHostedResourceLoader({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
    }),
    customTools: options?.customTools ?? [],
    extensions: [createHostedBehaviorHostAdapter({ runtime, registerTools: false })],
    initialModel: model,
    initialThinkingLevel: "off",
  });

  return { workspace, runtime, sessionStore, session, fauxProvider, model };
}

function createChannelTurn(text: string, meta?: TurnEnvelope["meta"]): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "channel-session:telegram",
    turnId: "turn-1",
    channel: "telegram",
    conversationId: "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text }],
    meta,
  };
}

function isSteerSessionEvent(
  event: BrewvaPromptSessionEvent,
): event is Extract<
  BrewvaPromptSessionEvent,
  { type: "steer_applied" } | { type: "steer_dropped" }
> {
  return event.type === "steer_applied" || event.type === "steer_dropped";
}

describe("in-flight steer control primitive", () => {
  test("appends a single steer to the last tool result in a multi-tool batch", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const releaseSecondTool = createDeferred();
    const secondToolStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }
      return createStream(
        createAssistantMessage(
          [
            { type: "toolCall", id: "tool-1", name: "first", arguments: {} },
            { type: "toolCall", id: "tool-2", name: "second", arguments: {} },
          ],
          "toolUse",
        ),
      );
    };

    const engine = createEngine(streamFn);
    engine.setTools([
      {
        name: "first",
        label: "First",
        description: "First tool",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "first result" }], details: { ok: true } };
        },
      },
      {
        name: "second",
        label: "Second",
        description: "Second tool",
        parameters: Type.Object({}),
        async execute() {
          secondToolStarted.resolve();
          await releaseSecondTool.promise;
          return { content: [{ type: "text", text: "second result" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("run both tools"));
      await secondToolStarted.promise;
      expect(engine.steer("prefer JSON output")).toBe(true);
      releaseSecondTool.resolve();
      await running;

      const toolResults = findToolResultMessages(events);
      const steerApplied = events.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_applied" }> =>
          event.type === "steer_applied",
      );

      expect(toolResults).toHaveLength(2);
      expect(JSON.stringify(toolResults[0])).not.toContain("User guidance:");
      expect(toolResults[1]?.content.at(-1)).toEqual({
        type: "text",
        text: "\n\nUser guidance: prefer JSON output",
      });
      expect(steerApplied?.toolCallId).toBe("tool-2");
      expect(steerApplied?.message).toEqual(toolResults[1]);
    } finally {
      unsubscribe();
    }
  });

  test("applies a steer queued after turn_end before the next model call", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    let streamCalls = 0;
    let secondCallSawGuidance = false;
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        return createStream(
          createAssistantMessage(
            [{ type: "toolCall", id: "tool-late", name: "late", arguments: {} }],
            "toolUse",
          ),
        );
      }
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      secondCallSawGuidance =
        lastMessage?.role === "toolResult" &&
        JSON.stringify(lastMessage).includes("User guidance: before next model call");
      return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
    };

    const engine = createEngine(streamFn);
    engine.setTools([
      {
        name: "late",
        label: "Late",
        description: "Late steer test tool",
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: "late result" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_end" && event.toolResults.length > 0) {
        expect(engine.steer("before next model call")).toBe(true);
      }
    });

    try {
      await engine.prompt(createUserPrompt("run late tool"));

      const toolResult = findToolResultMessages(events)[0];
      const dropped = events.find((event) => event.type === "steer_dropped");
      const applied = events.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_applied" }> =>
          event.type === "steer_applied",
      );

      expect(secondCallSawGuidance).toBe(true);
      expect(JSON.stringify(toolResult)).toContain("User guidance: before next model call");
      expect(dropped).toBe(undefined);
      expect(applied?.toolCallId).toBe("tool-late");
    } finally {
      unsubscribe();
    }
  });

  test("joins multiple steers before drain into one appended guidance block", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const releaseTool = createDeferred();
    const toolStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }
      return createStream(
        createAssistantMessage(
          [{ type: "toolCall", id: "tool-joined", name: "joined", arguments: {} }],
          "toolUse",
        ),
      );
    };

    const engine = createEngine(streamFn);
    engine.setTools([
      {
        name: "joined",
        label: "Joined",
        description: "Joined tool",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "joined result" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("run joined tool"));
      await toolStarted.promise;
      expect(engine.steer("stay concise")).toBe(true);
      expect(engine.steer("include edge cases")).toBe(true);
      releaseTool.resolve();
      await running;

      const toolResult = findToolResultMessages(events)[0];
      const guidanceParts =
        toolResult?.content.filter(
          (
            part,
          ): part is Extract<
            BrewvaTurnLoopToolResultMessage["content"][number],
            { type: "text" }
          > => part.type === "text" && part.text.includes("User guidance:"),
        ) ?? [];

      expect(guidanceParts).toHaveLength(1);
      expect(guidanceParts[0]?.text).toBe("\n\nUser guidance: stay concise\ninclude edge cases");
    } finally {
      unsubscribe();
    }
  });

  test("rejects empty steers from the direct session API without audit events", async () => {
    const fixture = await createManagedSessionFixture("steer-rejected-empty");

    try {
      expect(await fixture.session.steer("   ")).toEqual({ status: "rejected_empty" });
      expect(
        fixture.runtime.inspect.events.records
          .list(fixture.sessionStore.getSessionId())
          .filter((event) => event.type.startsWith("steer_")),
      ).toHaveLength(0);
    } finally {
      fixture.session.dispose();
      fixture.fauxProvider.unregister();
    }
  });

  test("drops a pending steer as aborted when the active run is interrupted", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, _context, options) =>
      createTurnStreamFromPromise(async () => {
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return createStream(createAssistantMessage([{ type: "text", text: "" }], "aborted"));
      });

    const engine = createEngine(streamFn);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("wait for abort"));
      expect(engine.steer("do not lose this")).toBe(true);
      engine.abort();
      await running;

      const dropped = events.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_dropped" }> =>
          event.type === "steer_dropped",
      );

      expect(dropped).toMatchObject({
        type: "steer_dropped",
        text: "do not lose this",
        reason: "aborted",
      });
      expect(engine.hasPendingSteer()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("drops a pending steer with no_tool_boundary when a successful turn has no tool calls", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const releaseStream = createDeferred();
    const streamStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = () =>
      createTurnStreamFromPromise(async () => {
        streamStarted.resolve();
        await releaseStream.promise;
        return createStream(createAssistantMessage([{ type: "text", text: "no tools needed" }]));
      });

    const engine = createEngine(streamFn);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("answer directly"));
      await streamStarted.promise;
      expect(engine.steer("late operator note")).toBe(true);
      releaseStream.resolve();
      await running;

      const dropped = events.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_dropped" }> =>
          event.type === "steer_dropped",
      );
      const userMessages = events.filter(
        (event) => event.type === "message_end" && event.message.role === "user",
      );

      expect(dropped).toMatchObject({
        type: "steer_dropped",
        text: "late operator note",
        reason: "no_tool_boundary",
      });
      expect(userMessages).toHaveLength(1);
      expect(engine.hasPendingSteer()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("drops a steer queued during the final turn_end when no next model call exists", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const engine = createEngine(() =>
      createStream(createAssistantMessage([{ type: "text", text: "done" }])),
    );
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_end") {
        expect(engine.steer("too late for this turn")).toBe(true);
      }
    });

    try {
      await engine.prompt(createUserPrompt("answer directly"));

      const dropped = events.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_dropped" }> =>
          event.type === "steer_dropped",
      );

      expect(dropped).toMatchObject({
        type: "steer_dropped",
        text: "too late for this turn",
        reason: "no_tool_boundary",
      });
      expect(engine.hasPendingSteer()).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  test("returns no_active_run for direct session steers when the run is idle", async () => {
    const fixture = await createManagedSessionFixture("steer-no-active-run");

    try {
      expect(await fixture.session.steer("still there?")).toEqual({ status: "no_active_run" });
      expect(
        fixture.runtime.inspect.events.records
          .list(fixture.sessionStore.getSessionId())
          .filter((event) => event.type.startsWith("steer_")),
      ).toHaveLength(0);
    } finally {
      fixture.session.dispose();
      fixture.fauxProvider.unregister();
    }
  });

  test("routes channel steers straight to the live session without queue dispatch", async () => {
    const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    const steers: string[] = [];
    let steerListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
    let unsubscribed = false;
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: ["owner", "@owner"] },
        aclModeWhenOwnersEmpty: "closed",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text, meta) => {
          replies.push({ text, meta });
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => {
          throw new Error("fanOut should not receive steer commands");
        },
        discuss: async () => {
          throw new Error("discuss should not receive steer commands");
        },
      },
      renderAgentsSnapshot: () => "agents snapshot",
      openLiveSession: () =>
        ({
          scopeKey: "scope-1",
          agentId: "worker",
          agentSessionId: "agent-session:worker",
          runtime: createRuntimeFixture(),
          subscribe: (listener: (event: BrewvaPromptSessionEvent) => void) => {
            steerListener = listener;
            return () => {
              unsubscribed = true;
              if (steerListener === listener) {
                steerListener = undefined;
              }
            };
          },
          steer: async (text: string) => {
            steers.push(text);
            return { status: "queued", chars: text.length };
          },
        }) as never,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const result = await router.handleCommand(
      { kind: "steer", text: "stay focused" },
      createChannelTurn("/steer stay focused", { senderUsername: "owner" }),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(steers).toEqual(["stay focused"]);
    expect(replies[0]?.text).toContain("Queued steer");
    expect(replies[0]?.meta).toMatchObject({
      command: "steer",
      status: "queued",
      agentSessionId: "agent-session:worker",
    });
    steerListener?.({
      type: "steer_dropped",
      text: "stay focused",
      reason: "no_tool_boundary",
    });
    expect(unsubscribed).toBe(true);
    expect(replies[1]?.text).toContain("Steer dropped for @worker");
    expect(replies[1]?.meta).toMatchObject({
      command: "steer",
      status: "dropped",
      reason: "no_tool_boundary",
      agentSessionId: "agent-session:worker",
    });
  });

  test("accepts daemon steer IPC even when send is busy-rejected", async () => {
    const backend = createSessionBackendStub({
      sendPrompt: async () => {
        throw new SessionBackendStateError(
          "session_busy",
          "session is busy with active turn: turn-123",
        );
      },
      steerSession: async (_sessionId, text) => ({
        status: "queued",
        chars: text.length,
      }),
    });
    const harness = createDaemonHarness([], { sessionBackend: backend });

    try {
      const handleMethod = getHandleMethod(harness.daemon);
      let sendError: unknown;
      try {
        await handleMethod(
          "sessions.send",
          {
            sessionId: "session-busy",
            prompt: "hello",
          },
          createConnectionState("conn-send-busy"),
        );
      } catch (error) {
        sendError = error;
      }

      expect(sendError).toMatchObject({
        code: "bad_state",
        details: {
          kind: "session_busy",
        },
      });

      const steerPayload = await handleMethod(
        "sessions.steer",
        {
          sessionId: "session-busy",
          text: "keep going",
        },
        createConnectionState("conn-steer-busy"),
      );

      expect(steerPayload).toEqual({
        sessionId: "session-busy",
        status: "queued",
        chars: "keep going".length,
      });
    } finally {
      harness.dispose();
    }
  });

  test("replays persisted steered tool results byte-identically from the recorded session", async () => {
    const fixture = await createManagedSessionFixture("steer-replay");

    try {
      const handleAgentEvent = (
        fixture.session as unknown as {
          handleAgentEvent(event: BrewvaTurnLoopEvent): Promise<void>;
        }
      ).handleAgentEvent.bind(fixture.session);
      const toolResultMessage: BrewvaTurnLoopToolResultMessage = {
        role: "toolResult",
        toolCallId: "hold-1",
        toolName: "hold",
        content: [
          { type: "text", text: "tool completed" },
          { type: "text", text: "\n\nUser guidance: persist this hint" },
        ],
        isError: false,
        timestamp: Date.now(),
      };

      await handleAgentEvent({ type: "message_start", message: toolResultMessage });
      await handleAgentEvent({ type: "message_end", message: toolResultMessage });
      await handleAgentEvent({
        type: "steer_applied",
        text: "persist this hint",
        toolCallId: "hold-1",
        toolName: "hold",
        message: toolResultMessage,
      });

      const eventTypes = fixture.runtime.inspect.events.records
        .list(fixture.sessionStore.getSessionId())
        .map((event) => event.type);
      const originalContext = fixture.sessionStore.buildSessionContext();
      const restoredStore = new HostedRuntimeTapeSessionStore(
        fixture.runtime,
        fixture.sessionStore.getSessionId(),
      );
      const restoredContext = restoredStore.buildSessionContext();
      const originalToolResult = [...originalContext.messages]
        .toReversed()
        .find((message) => message.role === "toolResult");
      const restoredToolResult = [...restoredContext.messages]
        .toReversed()
        .find((message) => message.role === "toolResult");

      expect(eventTypes.some((type) => type === "steer_applied")).toBe(true);
      const originalResult = requireDefined(originalToolResult, "expected original tool result");
      const restoredResult = requireDefined(restoredToolResult, "expected restored tool result");
      expect(JSON.stringify(restoredResult)).toBe(JSON.stringify(originalResult));
      expect(JSON.stringify(restoredResult)).toContain("User guidance: persist this hint");
    } finally {
      fixture.session.dispose();
      fixture.fauxProvider.unregister();
    }
  });

  test("applies afterToolCall transforms before appending the steer guidance", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const releaseTool = createDeferred();
    const toolStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }
      return createStream(
        createAssistantMessage(
          [{ type: "toolCall", id: "tool-1", name: "probe", arguments: {} }],
          "toolUse",
        ),
      );
    };

    const engine = createEngine(streamFn, {
      afterToolCall: async () => ({
        content: [{ type: "text", text: "afterToolCall content" }],
        details: undefined,
      }),
    });
    engine.setTools([
      {
        name: "probe",
        label: "Probe",
        description: "Probe tool",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "raw tool content" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("probe"));
      await toolStarted.promise;
      expect(engine.steer("append this after transforms")).toBe(true);
      releaseTool.resolve();
      await running;

      const toolResult = findToolResultMessages(events)[0];
      expect(toolResult?.content).toEqual([
        { type: "text", text: "afterToolCall content" },
        { type: "text", text: "\n\nUser guidance: append this after transforms" },
      ]);
    } finally {
      unsubscribe();
    }
  });

  test("emits steer_applied with the committed tool result after message_end transforms", async () => {
    const recordedEvents: BrewvaTurnLoopEvent[] = [];
    const releaseTool = createDeferred();
    const toolStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }
      return createStream(
        createAssistantMessage(
          [{ type: "toolCall", id: "tool-commit", name: "commit", arguments: {} }],
          "toolUse",
        ),
      );
    };

    const engine = createEngine(streamFn);
    engine.setTools([
      {
        name: "commit",
        label: "Commit",
        description: "Commit tool",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "base result" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribeTransform = engine.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        return {
          ...event,
          message: {
            ...event.message,
            details: { committed: true },
          },
        };
      }
      return undefined;
    });
    const unsubscribeRecord = engine.subscribe((event) => {
      recordedEvents.push(event);
    });

    try {
      const running = engine.prompt(createUserPrompt("commit"));
      await toolStarted.promise;
      expect(engine.steer("retain committed message")).toBe(true);
      releaseTool.resolve();
      await running;

      const committedToolResult = findToolResultMessages(recordedEvents)[0];
      const steerApplied = recordedEvents.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_applied" }> =>
          event.type === "steer_applied",
      );

      expect(committedToolResult?.details).toEqual({ committed: true });
      expect(steerApplied?.message).toEqual(committedToolResult);
      expect(steerApplied?.message.details).toEqual({ committed: true });
    } finally {
      unsubscribeRecord();
      unsubscribeTransform();
    }
  });

  test("drops steer when message_end replacement removes appended guidance", async () => {
    const recordedEvents: BrewvaTurnLoopEvent[] = [];
    const recordedScopes: BrewvaTurnEventScope[] = [];
    const releaseTool = createDeferred();
    const toolStarted = createDeferred();
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }
      return createStream(
        createAssistantMessage(
          [{ type: "toolCall", id: "tool-overwrite", name: "overwrite", arguments: {} }],
          "toolUse",
        ),
      );
    };

    const engine = createEngine(streamFn);
    engine.setTools([
      {
        name: "overwrite",
        label: "Overwrite",
        description: "Overwrite tool",
        parameters: Type.Object({}),
        async execute() {
          toolStarted.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "base result" }], details: { ok: true } };
        },
      },
    ]);
    const unsubscribeTransform = engine.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        return {
          ...event,
          message: {
            ...event.message,
            content: [{ type: "text", text: "plugin override" }],
          },
        };
      }
      return undefined;
    });
    const unsubscribeRecord = engine.subscribe((event, scope) => {
      recordedEvents.push(event);
      if (event.type === "steer_dropped" && scope) {
        recordedScopes.push(scope);
      }
    });

    try {
      const running = engine.prompt(createUserPrompt("overwrite"));
      await toolStarted.promise;
      expect(engine.steer("this guidance gets overwritten")).toBe(true);
      releaseTool.resolve();
      await running;

      const committedToolResult = findToolResultMessages(recordedEvents)[0];
      const steerDropped = recordedEvents.find(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "steer_dropped" }> =>
          event.type === "steer_dropped",
      );

      expect(committedToolResult?.content).toEqual([{ type: "text", text: "plugin override" }]);
      expect(JSON.stringify(committedToolResult)).not.toContain("User guidance:");
      expect(steerDropped).toMatchObject({
        type: "steer_dropped",
        text: "this guidance gets overwritten",
        reason: "overwritten",
      });
      expect(recordedScopes).toContainEqual(
        expect.objectContaining({
          toolInvocation: {
            toolCallId: "tool-overwrite",
            toolName: "overwrite",
          },
        }),
      );
    } finally {
      unsubscribeRecord();
      unsubscribeTransform();
    }
  });

  test("forwards typed steer session events to subscribers", async () => {
    const fixture = await createManagedSessionFixture("steer-typed-session-events");
    const observed: Array<
      Extract<BrewvaPromptSessionEvent, { type: "steer_applied" } | { type: "steer_dropped" }>
    > = [];
    const unsubscribe = fixture.session.subscribe((event) => {
      if (isSteerSessionEvent(event)) {
        observed.push(event);
      }
    });

    try {
      const handleAgentEvent = (
        fixture.session as unknown as {
          handleAgentEvent(event: BrewvaTurnLoopEvent): Promise<void>;
        }
      ).handleAgentEvent.bind(fixture.session);

      await handleAgentEvent({
        type: "steer_applied",
        text: "typed note",
        toolCallId: "tool-typed",
        toolName: "read",
        message: {
          role: "toolResult",
          toolCallId: "tool-typed",
          toolName: "read",
          content: [{ type: "text", text: "typed result" }],
          isError: false,
          timestamp: Date.now(),
        },
      });
      await handleAgentEvent({
        type: "steer_dropped",
        text: "typed note",
        reason: "failed",
      });

      expect(observed).toEqual([
        expect.objectContaining({
          type: "steer_applied",
          toolCallId: "tool-typed",
          toolName: "read",
        }),
        expect.objectContaining({
          type: "steer_dropped",
          reason: "failed",
        }),
      ]);
    } finally {
      unsubscribe();
      fixture.session.dispose();
      fixture.fauxProvider.unregister();
    }
  });
});
