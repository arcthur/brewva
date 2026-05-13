import { describe, expect, test } from "bun:test";
import { BrewvaEffect, BrewvaStream, runPromiseAtBoundary } from "@brewva/brewva-effect";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type { ToolExecutionPhase } from "@brewva/brewva-substrate/tools";
import {
  createBrewvaTurnLoopController,
  runBrewvaTurnLoop,
  type BrewvaTurnEventScope,
  type BrewvaTurnLoopAssistantMessage,
  type BrewvaTurnLoopAssistantMessageStream,
  type BrewvaTurnLoopAssistantMessageEvent,
  type BrewvaTurnLoopConfig,
  type BrewvaTurnLoopContext,
  type BrewvaTurnLoopEvent,
  type BrewvaTurnLoopLlmMessage,
  type BrewvaTurnLoopStreamFunction,
  type BrewvaTurnLoopToolResult,
} from "@brewva/brewva-substrate/turn";
import { Type } from "@sinclair/typebox";
import { createTurnEventStream } from "../../../helpers/effect-stream.js";
import { sleep } from "../../../helpers/process.js";

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

describe("turn loop controller", () => {
  test("rejects prompts until a model is configured", async () => {
    const engine = createBrewvaTurnLoopController({
      initialThinkingLevel: "off",
      sessionId: "session-missing-model",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "unused-key" }),
      streamFn: () => createStream(createAssistantMessage([{ type: "text", text: "unused" }])),
    });

    expect(engine.state.model).toBe(undefined);
    try {
      await engine.prompt({
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: Date.now(),
      });
      expect.unreachable("expected prompt without a model to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("requires a model before prompt()");
    }
  });

  test("forwards cache policy to the stream function", async () => {
    const calls: Array<unknown> = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, _context, options) => {
      calls.push(options.cachePolicy);
      return createStream(createAssistantMessage([{ type: "text", text: "done" }]));
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "minimal",
      sessionId: "session-cache-policy",
      cachePolicy: {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "config",
      },
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({
        ok: true,
        apiKey: "test-key",
      }),
      streamFn,
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(calls).toEqual([
      {
        retention: "long",
        writeMode: "readWrite",
        scope: "session",
        reason: "config",
      },
    ]);
  });

  test("resolves request auth before invoking the stream function", async () => {
    const calls: Array<{ apiKey?: string; headers?: Record<string, string> }> = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, _context, options) => {
      calls.push({
        apiKey: options.apiKey,
        headers: options.headers,
      });
      return createStream(createAssistantMessage([{ type: "text", text: "done" }]));
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "minimal",
      sessionId: "session-auth",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({
        ok: true,
        apiKey: "test-key",
        headers: { "x-brewva-auth": "1" },
      }),
      streamFn,
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(calls).toEqual([
      {
        apiKey: "test-key",
        headers: { "x-brewva-auth": "1" },
      },
    ]);
  });

  test("executes tool calls with local loop semantics and follow-up assistant turn", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }

      const partial = createAssistantMessage([]);
      const toolCallMessage = createAssistantMessage(
        [
          {
            type: "toolCall",
            id: "tool-1",
            name: "echo",
            arguments: { text: "hello" },
          },
        ],
        "toolUse",
      );
      return createStream(toolCallMessage, [
        { type: "start", partial },
        {
          type: "toolcall_start",
          contentIndex: 0,
          partial,
        },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"text":"hello"}',
          partial,
        },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: toolCallMessage.content[0] as Extract<
            BrewvaTurnLoopAssistantMessage["content"][number],
            { type: "toolCall" }
          >,
          partial: toolCallMessage,
        },
      ]);
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-loop",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    engine.setTools([
      {
        name: "echo",
        label: "Echo",
        description: "Echoes text",
        parameters: Type.Object({
          text: Type.String(),
        }),
        async execute(_toolCallId, params, _signal, onUpdate) {
          await onUpdate?.({
            content: [{ type: "text", text: `partial:${(params as { text: string }).text}` }],
            details: { phase: "partial" },
          });
          return {
            content: [{ type: "text", text: `done:${(params as { text: string }).text}` }],
            details: { phase: "done" },
          };
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "call tool" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(
      events
        .map((event) => event.type)
        .filter(
          (type) =>
            type === "tool_execution_start" ||
            type === "tool_execution_update" ||
            type === "tool_execution_end",
        ),
    ).toEqual(["tool_execution_start", "tool_execution_update", "tool_execution_end"]);

    const turnEnds = events.filter(
      (event): event is Extract<BrewvaTurnLoopEvent, { type: "turn_end" }> =>
        event.type === "turn_end",
    );
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.toolResults).toHaveLength(1);
    expect(turnEnds[1]?.message.role).toBe("assistant");
    expect(engine.state.isStreaming).toBe(false);
    expect(engine.hasQueuedMessages()).toBe(false);
  });

  test("serializes asynchronous tool update emissions before tool execution end", async () => {
    const observed: string[] = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }

      return createStream(
        createAssistantMessage(
          [
            {
              type: "toolCall",
              id: "tool-update-order-1",
              name: "ordered_update",
              arguments: {},
            },
          ],
          "toolUse",
        ),
      );
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-update-order",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe(async (event) => {
      if (event.type === "tool_execution_update") {
        const partialResult = event.partialResult as BrewvaTurnLoopToolResult;
        const firstContent = partialResult.content[0];
        const text = firstContent?.type === "text" ? firstContent.text : "unknown";
        if (text === "first") {
          await sleep(20);
        }
        observed.push(text);
      }
      if (event.type === "tool_execution_end") {
        observed.push("end");
      }
    });

    engine.setTools([
      {
        name: "ordered_update",
        label: "Ordered Update",
        description: "Emits ordered partial results",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, onUpdate) {
          await onUpdate?.({
            content: [{ type: "text", text: "first" }],
            details: undefined,
          });
          await onUpdate?.({
            content: [{ type: "text", text: "second" }],
            details: undefined,
          });
          return {
            content: [{ type: "text", text: "done" }],
            details: undefined,
          };
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "call tool" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(observed).toEqual(["first", "second", "end"]);
  });

  test("emits explicit tool execution phase transitions across the hosted loop", async () => {
    const observedPhases: ToolExecutionPhase[] = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }

      const toolCallMessage = createAssistantMessage(
        [
          {
            type: "toolCall",
            id: "tool-phase-1",
            name: "echo",
            arguments: { text: "hello" },
          },
        ],
        "toolUse",
      );
      return createStream(toolCallMessage);
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-phase-loop",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "tool_execution_phase_change") {
        observedPhases.push(event.phase);
      }
    });

    engine.setTools([
      {
        name: "echo",
        label: "Echo",
        description: "Echoes text",
        parameters: Type.Object({
          text: Type.String(),
        }),
        async execute(_toolCallId, params) {
          return {
            content: [{ type: "text", text: `done:${(params as { text: string }).text}` }],
            details: { phase: "done" },
          };
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "call tool" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(observedPhases).toEqual([
      "classify",
      "authorize",
      "prepare",
      "execute",
      "record",
      "cleanup",
    ]);
  });

  test("attaches one tool invocation scope across the complete tool lifecycle", async () => {
    const observed: Array<{
      type: BrewvaTurnLoopEvent["type"];
      phase?: ToolExecutionPhase;
      scope?: BrewvaTurnEventScope;
    }> = [];
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }

      return createStream(
        createAssistantMessage(
          [
            {
              type: "toolCall",
              id: "scope-tool-1",
              name: "scoped_tool",
              arguments: {},
            },
          ],
          "toolUse",
        ),
      );
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-scope",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event, scope) => {
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_phase_change" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end" ||
        (event.type === "message_start" && event.message.role === "toolResult") ||
        (event.type === "message_end" && event.message.role === "toolResult") ||
        event.type === "steer_applied"
      ) {
        observed.push({
          type: event.type,
          phase: event.type === "tool_execution_phase_change" ? event.phase : undefined,
          scope,
        });
      }
      if (event.type === "tool_execution_end") {
        expect(engine.steer("operator steer")).toBe(true);
      }
    });

    engine.setTools([
      {
        name: "scoped_tool",
        label: "Scoped Tool",
        description: "Emits partial output",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, onUpdate) {
          await onUpdate?.({
            content: [{ type: "text", text: "partial" }],
            details: undefined,
          });
          return {
            content: [{ type: "text", text: "done" }],
            details: undefined,
          };
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "call scoped tool" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(
      observed.map((entry) =>
        entry.type === "tool_execution_phase_change" ? `${entry.type}:${entry.phase}` : entry.type,
      ),
    ).toEqual([
      "tool_execution_start",
      "tool_execution_phase_change:classify",
      "tool_execution_phase_change:authorize",
      "tool_execution_phase_change:prepare",
      "tool_execution_phase_change:execute",
      "tool_execution_update",
      "tool_execution_phase_change:record",
      "tool_execution_end",
      "message_start",
      "message_end",
      "tool_execution_phase_change:cleanup",
      "steer_applied",
    ]);
    expect(
      observed.map((entry) => ({
        turnSessionId: entry.scope?.turn.sessionId,
        toolCallId: entry.scope?.toolInvocation?.toolCallId,
        toolName: entry.scope?.toolInvocation?.toolName,
      })),
    ).toEqual(
      observed.map(() => ({
        turnSessionId: "session-tool-scope",
        toolCallId: "scope-tool-1",
        toolName: "scoped_tool",
      })),
    );
  });

  test("surfaces tool argument validation failures without entering authorize or execute", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const observedPhases: ToolExecutionPhase[] = [];
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
            {
              type: "toolCall",
              id: "tool-invalid-1",
              name: "echo",
              arguments: {},
            },
          ],
          "toolUse",
        ),
      );
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-validation",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
      if (event.type === "tool_execution_phase_change") {
        observedPhases.push(event.phase);
      }
    });

    engine.setTools([
      {
        name: "echo",
        label: "Echo",
        description: "Echoes text",
        parameters: Type.Object({
          text: Type.String(),
        }),
        async execute() {
          throw new Error("execute should not run for invalid arguments");
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "call tool with invalid args" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(observedPhases).toEqual(["classify", "cleanup"]);

    const toolEnd = events.find(
      (event): event is Extract<BrewvaTurnLoopEvent, { type: "tool_execution_end" }> =>
        event.type === "tool_execution_end",
    );
    expect(toolEnd?.isError).toBe(true);
    expect(toolEnd?.result).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('Validation failed for tool "echo"'),
          }),
        ],
      }),
    );

    const firstTurnEnd = events.find(
      (event): event is Extract<BrewvaTurnLoopEvent, { type: "turn_end" }> =>
        event.type === "turn_end" && event.toolResults.length > 0,
    );
    expect(firstTurnEnd?.toolResults).toHaveLength(1);
    expect(firstTurnEnd?.toolResults[0]?.isError).toBe(true);
  });

  test("emits a durable failure message before agent_end when the stream function throws", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    const streamFn: BrewvaTurnLoopStreamFunction = () => {
      throw new Error("provider exploded");
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-run-failure",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "boom-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "fail please" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    const messageEndIndex = events.findIndex(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error",
    );
    const agentEndIndex = events.findIndex((event) => event.type === "agent_end");
    expect(messageEndIndex).toBeGreaterThanOrEqual(0);
    expect(agentEndIndex).toBeGreaterThan(messageEndIndex);

    const messageEndEvent = events[messageEndIndex];
    expect(messageEndEvent).toMatchObject({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider exploded",
        excludeFromContext: true,
      },
    });
    const agentEndEvent = events[agentEndIndex];
    expect(agentEndEvent).toMatchObject({
      type: "agent_end",
      messages: [
        { role: "user" },
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "provider exploded",
          excludeFromContext: true,
        },
      ],
    });
  });

  test("abort interrupts the active Effect stream fiber", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    let streamFinalized = false;
    const streamFn: BrewvaTurnLoopStreamFunction = () => {
      streamStarted();
      return BrewvaStream.never.pipe(
        BrewvaStream.ensuring(
          BrewvaEffect.sync(() => {
            streamFinalized = true;
          }),
        ),
      ) as BrewvaTurnLoopAssistantMessageStream;
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-effect-interrupt",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "interrupt-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    const promptPromise = engine.prompt({
      role: "user",
      content: [{ type: "text", text: "wait" }],
      timestamp: Date.now(),
    });
    await streamStartedPromise;
    engine.abort();
    await promptPromise;
    unsubscribe();

    expect(streamFinalized).toBe(true);
    expect(engine.state.isStreaming).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "aborted",
      ),
    ).toBe(true);
  });

  test("passes abort signals to Promise turn boundary callbacks", async () => {
    const abortController = new AbortController();
    const callbackSignals: AbortSignal[] = [];
    let queueStarted!: () => void;
    const queueStartedPromise = new Promise<void>((resolve) => {
      queueStarted = resolve;
    });

    const prompt = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "wait before stream" }],
      timestamp: Date.now(),
    };
    const context: BrewvaTurnLoopContext = {
      systemPrompt: "",
      messages: [],
      tools: [],
    };
    const config: BrewvaTurnLoopConfig = {
      model: TEST_MODEL,
      transport: "sse",
      onPayload: (payload) => payload,
      transformContext: (messages, signal) => {
        if (signal) {
          callbackSignals.push(signal);
        }
        queueStarted();
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(messages), { once: true });
        });
      },
      resolveRequestAuth: async () => ({ ok: true, apiKey: "unused-key" }),
      streamFn: () => createStream(createAssistantMessage([{ type: "text", text: "unexpected" }])),
    };

    const runPromise = runPromiseAtBoundary(
      runBrewvaTurnLoop([prompt], context, config, () => undefined, abortController.signal).pipe(
        BrewvaEffect.provide(providerRuntimeLayer),
      ),
      { signal: abortController.signal },
    ).catch(() => undefined);

    await queueStartedPromise;
    abortController.abort();
    await runPromise;

    expect(callbackSignals).toHaveLength(1);
    expect(callbackSignals[0]?.aborted).toBe(true);
  });

  test("excludes failed assistant turns from the next provider request context", async () => {
    const streamContexts: BrewvaTurnLoopLlmMessage[][] = [];
    let streamCalls = 0;
    const failedMessage = {
      ...createAssistantMessage(
        [{ type: "text", text: "partial answer before server_error" }],
        "error",
      ),
      errorMessage: "server_error",
    };
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      streamCalls += 1;
      streamContexts.push([...context.messages]);
      if (streamCalls === 1) {
        return createStream(failedMessage);
      }
      return createStream(createAssistantMessage([{ type: "text", text: "recovered" }]));
    };

    const events: BrewvaTurnLoopEvent[] = [];
    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-retry-after-failure",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "retry-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    });
    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "continue" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    const failedEnd = events.find(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error",
    );
    expect(failedEnd).toMatchObject({
      type: "message_end",
      message: {
        role: "assistant",
        excludeFromContext: true,
      },
    });
    expect(streamContexts).toHaveLength(2);
    expect(
      streamContexts[1]?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text.includes("partial answer before server_error"),
          ),
      ),
    ).toBe(false);
  });

  test("stops the current loop after boundary tool results when requested", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    let streamCalls = 0;
    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      streamCalls += 1;
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "unexpected resume" }]));
      }
      const partial = createAssistantMessage([]);
      const toolCallMessage = createAssistantMessage(
        [
          {
            type: "toolCall",
            id: "tool-compact-1",
            name: "workbench_compact",
            arguments: {},
          },
        ],
        "toolUse",
      );
      return createStream(toolCallMessage, [
        { type: "start", partial },
        {
          type: "toolcall_start",
          contentIndex: 0,
          partial,
        },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: toolCallMessage.content[0] as Extract<
            BrewvaTurnLoopAssistantMessage["content"][number],
            { type: "toolCall" }
          >,
          partial: toolCallMessage,
        },
      ]);
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-stop-after-compaction",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      shouldStopAfterToolResults: async (toolResults) =>
        toolResults.some((result) => result.toolName === "workbench_compact"),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    engine.setTools([
      {
        name: "workbench_compact",
        label: "Session Compact",
        description: "Compacts session state",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [{ type: "text", text: "compaction requested" }],
            details: { ok: true },
          };
        },
      },
    ]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "compact now" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(streamCalls).toBe(1);
    expect(
      events.filter(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "turn_end" }> =>
          event.type === "turn_end",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "agent_end" }> =>
          event.type === "agent_end",
      ),
    ).toHaveLength(1);
  });

  test("refreshes active tools between provider turns inside the same run", async () => {
    const toolsSeenByStream: string[][] = [];
    let engine: ReturnType<typeof createBrewvaTurnLoopController>;

    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      toolsSeenByStream.push((context.tools ?? []).map((tool) => tool.name));
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaTurnLoopLlmMessage
        | undefined;
      if (lastMessage?.role === "toolResult") {
        return createStream(createAssistantMessage([{ type: "text", text: "final" }]));
      }

      return createStream(
        createAssistantMessage(
          [
            {
              type: "toolCall",
              id: "tool-refresh-1",
              name: "first",
              arguments: {},
            },
          ],
          "toolUse",
        ),
      );
    };

    const secondTool = {
      name: "second",
      label: "Second",
      description: "Second tool",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text" as const, text: "second" }],
          details: { ok: true },
        };
      },
    };
    const firstTool = {
      name: "first",
      label: "First",
      description: "First tool",
      parameters: Type.Object({}),
      async execute() {
        engine.setTools([firstTool, secondTool]);
        return {
          content: [{ type: "text" as const, text: "first" }],
          details: { ok: true },
        };
      },
    };

    engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-refresh-tools",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    engine.setTools([firstTool]);

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "refresh tools" }],
      timestamp: Date.now(),
    });

    expect(toolsSeenByStream).toEqual([["first"], ["first", "second"]]);
  });

  test("drains follow-up messages queued by turn_end handlers before agent_end", async () => {
    const events: BrewvaTurnLoopEvent[] = [];
    let streamCalls = 0;

    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      streamCalls += 1;
      const sawGuardFollowUp = context.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (content) =>
              content.type === "text" && content.text.includes("complete the active skill"),
          ),
      );
      return createStream(
        createAssistantMessage([
          { type: "text", text: sawGuardFollowUp ? "guard handled" : "initial stop" },
        ]),
      );
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-agent-end-follow-up",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    let queuedGuard = false;
    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
      if (event.type === "turn_end" && !queuedGuard) {
        queuedGuard = true;
        engine.followUp({
          role: "custom",
          customType: "brewva-guard",
          content: "complete the active skill",
          display: true,
          timestamp: Date.now(),
        });
      }
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "stop early" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(streamCalls).toBe(2);
    expect(engine.hasQueuedMessages()).toBe(false);
    expect(
      events.filter(
        (event): event is Extract<BrewvaTurnLoopEvent, { type: "agent_end" }> =>
          event.type === "agent_end",
      ),
    ).toHaveLength(1);
  });

  test("applies message_end transforms before storing messages for later provider turns", async () => {
    const streamContexts: BrewvaTurnLoopLlmMessage[][] = [];
    let streamCalls = 0;

    const streamFn: BrewvaTurnLoopStreamFunction = (_model, context) => {
      streamCalls += 1;
      streamContexts.push([...context.messages]);
      return createStream(
        createAssistantMessage([
          { type: "text", text: streamCalls === 1 ? "invalid draft summary" : "clean answer" },
        ]),
      );
    };

    const engine = createBrewvaTurnLoopController({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-message-end-transform-context",
      queueMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.content.some(
          (part) => part.type === "text" && part.text.includes("invalid draft summary"),
        )
      ) {
        return {
          ...event,
          message: {
            ...event.message,
            display: false,
            excludeFromContext: true,
            details: {
              brewvaDraftSuppressed: {
                reason: "test_contract",
              },
            },
          },
        };
      }
      return undefined;
    });

    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    });
    await engine.prompt({
      role: "user",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    });

    unsubscribe();

    expect(streamContexts).toHaveLength(2);
    expect(
      streamContexts[1]?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) => part.type === "text" && part.text.includes("invalid draft summary"),
          ),
      ),
    ).toBe(false);
  });
});
