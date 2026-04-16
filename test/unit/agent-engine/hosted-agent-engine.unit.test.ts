import { describe, expect, test } from "bun:test";
import {
  createHostedAgentEngine,
  type BrewvaAgentEngineAssistantMessage,
  type BrewvaAgentEngineAssistantMessageEvent,
  type BrewvaAgentEngineEvent,
  type BrewvaAgentEngineLlmMessage,
  type BrewvaAgentEngineStreamFunction,
} from "@brewva/brewva-agent-engine";
import type { BrewvaRegisteredModel, ToolExecutionPhase } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";

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
  content: BrewvaAgentEngineAssistantMessage["content"],
  stopReason: BrewvaAgentEngineAssistantMessage["stopReason"] = "stop",
): BrewvaAgentEngineAssistantMessage {
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
  finalMessage: BrewvaAgentEngineAssistantMessage,
  events: BrewvaAgentEngineAssistantMessageEvent[] = [],
): AsyncIterable<BrewvaAgentEngineAssistantMessageEvent> & {
  result(): Promise<BrewvaAgentEngineAssistantMessage>;
} {
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

  return {
    async *[Symbol.asyncIterator]() {
      for (const event of allEvents) {
        yield event;
      }
    },
    async result() {
      return finalMessage;
    },
  };
}

describe("hosted agent engine", () => {
  test("resolves request auth before invoking the stream function", async () => {
    const calls: Array<{ apiKey?: string; headers?: Record<string, string> }> = [];
    const streamFn: BrewvaAgentEngineStreamFunction = async (_model, _context, options) => {
      calls.push({
        apiKey: options.apiKey,
        headers: options.headers,
      });
      return createStream(createAssistantMessage([{ type: "text", text: "done" }]));
    };

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "minimal",
      sessionId: "session-auth",
      steeringMode: "one-at-a-time",
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
    const events: BrewvaAgentEngineEvent[] = [];
    const streamFn: BrewvaAgentEngineStreamFunction = async (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaAgentEngineLlmMessage
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
            BrewvaAgentEngineAssistantMessage["content"][number],
            { type: "toolCall" }
          >,
          partial: toolCallMessage,
        },
      ]);
    };

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-loop",
      steeringMode: "one-at-a-time",
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
          onUpdate?.({
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
      (event): event is Extract<BrewvaAgentEngineEvent, { type: "turn_end" }> =>
        event.type === "turn_end",
    );
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.toolResults).toHaveLength(1);
    expect(turnEnds[1]?.message.role).toBe("assistant");
    expect(engine.state.isStreaming).toBe(false);
    expect(engine.hasQueuedMessages()).toBe(false);
  });

  test("emits explicit tool execution phase transitions across the hosted loop", async () => {
    const observedPhases: ToolExecutionPhase[] = [];
    const streamFn: BrewvaAgentEngineStreamFunction = async (_model, context, _options) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaAgentEngineLlmMessage
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

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-phase-loop",
      steeringMode: "one-at-a-time",
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

  test("surfaces tool argument validation failures without entering authorize or execute", async () => {
    const events: BrewvaAgentEngineEvent[] = [];
    const observedPhases: ToolExecutionPhase[] = [];
    const streamFn: BrewvaAgentEngineStreamFunction = async (_model, context) => {
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaAgentEngineLlmMessage
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

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-tool-validation",
      steeringMode: "one-at-a-time",
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
      (event): event is Extract<BrewvaAgentEngineEvent, { type: "tool_execution_end" }> =>
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
      (event): event is Extract<BrewvaAgentEngineEvent, { type: "turn_end" }> =>
        event.type === "turn_end" && event.toolResults.length > 0,
    );
    expect(firstTurnEnd?.toolResults).toHaveLength(1);
    expect(firstTurnEnd?.toolResults[0]?.isError).toBe(true);
  });

  test("emits a durable failure message before agent_end when the stream function throws", async () => {
    const events: BrewvaAgentEngineEvent[] = [];
    const streamFn: BrewvaAgentEngineStreamFunction = async () => {
      throw new Error("provider exploded");
    };

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-run-failure",
      steeringMode: "one-at-a-time",
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
      },
    });
  });

  test("stops the current loop after boundary tool results when requested", async () => {
    const events: BrewvaAgentEngineEvent[] = [];
    let streamCalls = 0;
    const streamFn: BrewvaAgentEngineStreamFunction = async (_model, context) => {
      streamCalls += 1;
      const lastMessage = context.messages[context.messages.length - 1] as
        | BrewvaAgentEngineLlmMessage
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
            name: "session_compact",
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
            BrewvaAgentEngineAssistantMessage["content"][number],
            { type: "toolCall" }
          >,
          partial: toolCallMessage,
        },
      ]);
    };

    const engine = createHostedAgentEngine({
      initialModel: TEST_MODEL,
      initialThinkingLevel: "off",
      sessionId: "session-stop-after-compaction",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      transport: "sse",
      thinkingBudgets: undefined,
      maxRetryDelayMs: 1000,
      beforeToolCall: async () => undefined,
      afterToolCall: async () => undefined,
      onPayload: async (payload) => payload,
      transformContext: async (messages) => messages,
      resolveRequestAuth: async () => ({ ok: true, apiKey: "tool-key" }),
      shouldStopAfterToolResults: (toolResults) =>
        toolResults.some((result) => result.toolName === "session_compact"),
      streamFn,
    });

    const unsubscribe = engine.subscribe((event) => {
      events.push(event);
    });

    engine.setTools([
      {
        name: "session_compact",
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
        (event): event is Extract<BrewvaAgentEngineEvent, { type: "turn_end" }> =>
          event.type === "turn_end",
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event): event is Extract<BrewvaAgentEngineEvent, { type: "agent_end" }> =>
          event.type === "agent_end",
      ),
    ).toHaveLength(1);
  });
});
