import { describe, expect, test } from "bun:test";
import type { Model } from "@brewva/brewva-provider-core/contracts";
import { buildBaseOptions } from "../../../packages/brewva-provider-core/src/providers/_shared/simple-options.js";
import {
  resolveCodexTransport,
  shouldAttemptCodexWebSocketTransport,
  streamOpenAICodexResponses,
} from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/adapter.js";
import { rememberCodexContinuationState } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/continuation-state.js";
import type { RequestBody } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/contract.js";
import {
  buildCodexContinuationRequest,
  buildRequestBody,
} from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/request.js";
import { processWebSocketStream } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/websocket.js";
import {
  clearCodexSessionState,
  getCodexSessionCacheState,
  isCodexWebSocketFallbackActive,
  rememberCachedWebSocketConnection,
  recordCodexWebSocketFallback,
} from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/websocket.js";
import { createAssistantMessage } from "../../../packages/brewva-provider-core/src/stream/assistant-message.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/stream/tool-call-folder.js";
import {
  collectProviderEvents,
  createRecordingProviderEventStream,
} from "../../helpers/effect-stream.js";
import { sleep } from "../../helpers/process.js";

class FakeCodexWebSocket {
  static sockets: FakeCodexWebSocket[] = [];

  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readyState = 0;

  constructor() {
    FakeCodexWebSocket.sockets.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch("open", {});
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.dispatch("close", { code, reason });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchMessage(payload: Record<string, unknown>): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const CODEX_MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-5.4-codex",
  name: "GPT-5.4 Codex",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function createCodexStreamHarness() {
  const stream = createRecordingProviderEventStream();
  const output = createAssistantMessage(CODEX_MODEL);
  const toolCalls = new IncrementalToolCallFolder(output, stream, async () => {});
  return { stream, output, toolCalls };
}

async function waitForSentSocket(index: number): Promise<FakeCodexWebSocket> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = FakeCodexWebSocket.sockets[index];
    if (socket && socket.sent.length > 0) {
      return socket;
    }
    await sleep(0);
  }
  throw new Error(`Expected websocket ${index} to send a request`);
}

function createFakeCodexToken(): string {
  const payload = btoa(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
    }),
  );
  return `header.${payload}.signature`;
}

function createSseResponse(events: readonly Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

describe("openai codex responses continuation", () => {
  test("clears continuation state and cached websocket on explicit session clear", () => {
    const socket = {
      closeCalls: [] as Array<{ code?: number; reason?: string }>,
      close(code?: number, reason?: string) {
        this.closeCalls.push({ code, reason });
      },
    };

    rememberCodexContinuationState("session-clear", {
      model: "gpt-5.4-codex",
      previousRequest: {
        model: "gpt-5.4-codex",
      },
      lastResponse: {
        responseId: "resp_clear",
        outputItems: [] as never,
      },
    });
    rememberCachedWebSocketConnection("session-clear", socket as never);
    recordCodexWebSocketFallback("session-clear");

    expect(isCodexWebSocketFallbackActive("session-clear")).toBe(true);
    expect(getCodexSessionCacheState()).toEqual({
      websocketSessionCount: 1,
      continuationSessionCount: 1,
      websocketFallbackSessionCount: 1,
    });

    clearCodexSessionState("session-clear");

    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "session_clear" }]);
    expect(isCodexWebSocketFallbackActive("session-clear")).toBe(false);
    expect(getCodexSessionCacheState()).toEqual({
      websocketSessionCount: 0,
      continuationSessionCount: 0,
      websocketFallbackSessionCount: 0,
    });
  });

  test("defaults to auto transport and skips repeated auto websocket attempts after fallback", () => {
    clearCodexSessionState("session-fallback");

    expect(resolveCodexTransport(undefined)).toBe("auto");
    expect(shouldAttemptCodexWebSocketTransport("auto", "session-fallback")).toBe(true);

    recordCodexWebSocketFallback("session-fallback");

    expect(isCodexWebSocketFallbackActive("session-fallback")).toBe(true);
    expect(shouldAttemptCodexWebSocketTransport("auto", "session-fallback")).toBe(false);
    expect(shouldAttemptCodexWebSocketTransport("websocket", "session-fallback")).toBe(true);

    clearCodexSessionState("session-fallback");
  });

  test("preserves transport and file resolution options for simple streams", () => {
    const resolveFile = () => undefined;
    const options = buildBaseOptions(CODEX_MODEL, {
      transport: "sse",
      resolveFile,
    });

    expect(options.transport).toBe("sse");
    expect(options.resolveFile).toBe(resolveFile);
  });

  test("clamps GPT-5.5 minimal reasoning to low for Codex requests", () => {
    const model: Model<"openai-codex-responses"> = {
      ...CODEX_MODEL,
      id: "gpt-5.5",
      name: "GPT-5.5",
    };

    const body = buildRequestBody(model, { messages: [] }, { reasoningEffort: "minimal" });

    expect(body.reasoning).toEqual({
      effort: "low",
      summary: "auto",
    });
  });

  test("does not remember continuation from an uncached websocket after session clear", async () => {
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeCodexWebSocket;
    FakeCodexWebSocket.sockets = [];
    clearCodexSessionState("session-concurrent-clear");
    try {
      const first = createCodexStreamHarness();
      const firstRun = processWebSocketStream(
        "wss://chatgpt.example/codex/responses",
        {
          model: CODEX_MODEL.id,
          stream: true,
          input: [],
        },
        new Headers(),
        first.output,
        first.stream,
        CODEX_MODEL,
        first.toolCalls,
        () => undefined,
        { sessionId: "session-concurrent-clear" },
      ).catch(() => undefined);
      const cachedSocket = await waitForSentSocket(0);

      const second = createCodexStreamHarness();
      const secondRun = processWebSocketStream(
        "wss://chatgpt.example/codex/responses",
        {
          model: CODEX_MODEL.id,
          stream: true,
          input: [],
        },
        new Headers(),
        second.output,
        second.stream,
        CODEX_MODEL,
        second.toolCalls,
        () => undefined,
        { sessionId: "session-concurrent-clear" },
      );
      const uncachedSocket = await waitForSentSocket(1);

      clearCodexSessionState("session-concurrent-clear");
      expect(cachedSocket.closeCalls).toEqual([{ code: 1000, reason: "session_clear" }]);
      expect(uncachedSocket.closeCalls).toEqual([]);

      uncachedSocket.dispatchMessage({
        type: "response.completed",
        response: {
          id: "resp_after_clear",
          status: "completed",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      });

      await secondRun;
      await firstRun;

      expect(getCodexSessionCacheState()).toEqual({
        websocketSessionCount: 0,
        continuationSessionCount: 0,
        websocketFallbackSessionCount: 0,
      });
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });

  test("websocket processor leaves start emission to the provider stream owner", async () => {
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeCodexWebSocket;
    FakeCodexWebSocket.sockets = [];
    clearCodexSessionState("session-websocket-start-owner");
    try {
      const harness = createCodexStreamHarness();
      const run = processWebSocketStream(
        "wss://chatgpt.example/codex/responses",
        {
          model: CODEX_MODEL.id,
          stream: true,
          input: [],
        },
        new Headers(),
        harness.output,
        harness.stream,
        CODEX_MODEL,
        harness.toolCalls,
        () => undefined,
        { sessionId: "session-websocket-start-owner" },
      );
      const socket = await waitForSentSocket(0);
      socket.dispatchMessage({
        type: "response.completed",
        response: {
          id: "resp_websocket_start_owner",
          status: "completed",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
          },
        },
      });

      await run;

      expect(harness.stream.events.filter((event) => event.type === "start")).toEqual([]);
    } finally {
      clearCodexSessionState("session-websocket-start-owner");
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });

  test("sends only the new input delta when previous response state matches", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "input_text", text: "First turn" }],
    };
    const assistantOutput = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "First answer", annotations: [] }],
    };
    const secondUser = {
      role: "user",
      content: [{ type: "input_text", text: "Second turn" }],
    };

    const outbound = buildCodexContinuationRequest(
      {
        model: "gpt-5.4-codex",
        stream: true,
        instructions: "stable instructions",
        prompt_cache_key: "conversation-1",
        input: [firstUser, assistantOutput, secondUser] as never,
      },
      {
        model: "gpt-5.4-codex",
        previousRequest: {
          model: "gpt-5.4-codex",
          stream: true,
          instructions: "stable instructions",
          prompt_cache_key: "conversation-1",
          input: [firstUser] as never,
        },
        lastResponse: {
          responseId: "resp_1",
          outputItems: [assistantOutput] as never,
        },
      },
    );

    expect(outbound.previous_response_id).toBe("resp_1");
    expect(outbound.input as unknown).toEqual([secondUser]);
  });

  test("matches reconstructed tool-call continuations despite provider-only item metadata", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "input_text", text: "Use a tool" }],
    };
    const reasoningOutput = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque",
      summary: [],
    };
    const providerToolCallOutput = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "task_view_state",
      arguments: "{}",
      status: "completed",
    };
    const reconstructedToolCallOutput = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "task_view_state",
      arguments: "{}",
    };
    const toolResult = {
      type: "function_call_output",
      call_id: "call_1",
      output: "ok",
    };

    const outbound = buildCodexContinuationRequest(
      {
        model: "gpt-5.3-codex",
        stream: true,
        instructions: "stable instructions",
        prompt_cache_key: "conversation-1",
        input: [firstUser, reasoningOutput, reconstructedToolCallOutput, toolResult] as never,
      },
      {
        model: "gpt-5.3-codex",
        previousRequest: {
          model: "gpt-5.3-codex",
          stream: true,
          instructions: "stable instructions",
          prompt_cache_key: "conversation-1",
          input: [firstUser] as never,
        },
        lastResponse: {
          responseId: "resp_1",
          outputItems: [reasoningOutput, providerToolCallOutput] as never,
        },
      },
    );

    expect(outbound.previous_response_id).toBe("resp_1");
    expect(outbound.input as unknown).toEqual([toolResult]);
  });

  test("uses previous response id for tool-result continuations when instructions drift", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "input_text", text: "Use a tool" }],
    };
    const reasoningOutput = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque",
      summary: [],
    };
    const toolCallOutput = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "task_view_state",
      arguments: "{}",
      status: "completed",
    };
    const reconstructedToolCallOutput = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "task_view_state",
      arguments: "{}",
    };
    const toolResult = {
      type: "function_call_output",
      call_id: "call_1",
      output: "ok",
    };

    const outbound = buildCodexContinuationRequest(
      {
        model: "gpt-5.3-codex",
        stream: true,
        instructions: "changed instructions",
        prompt_cache_key: "conversation-1",
        input: [firstUser, reasoningOutput, reconstructedToolCallOutput, toolResult] as never,
      },
      {
        model: "gpt-5.3-codex",
        previousRequest: {
          model: "gpt-5.3-codex",
          stream: true,
          instructions: "stable instructions",
          prompt_cache_key: "conversation-1",
          input: [firstUser] as never,
        },
        lastResponse: {
          responseId: "resp_1",
          outputItems: [reasoningOutput, toolCallOutput] as never,
        },
      },
    );

    expect(outbound.previous_response_id).toBe("resp_1");
    expect(outbound.input as unknown).toEqual([toolResult]);
  });

  test("sends only the new input delta when non-input request shape drifts", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "input_text", text: "First turn" }],
    };
    const secondUser = {
      role: "user",
      content: [{ type: "input_text", text: "Second turn" }],
    };
    const assistantOutput = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "First answer", annotations: [] }],
    };
    const fullInput = [firstUser, assistantOutput, secondUser];

    const outbound = buildCodexContinuationRequest(
      {
        model: "gpt-5.4-codex",
        stream: true,
        instructions: "changed instructions",
        prompt_cache_key: "conversation-1",
        input: fullInput as never,
      },
      {
        model: "gpt-5.4-codex",
        previousRequest: {
          model: "gpt-5.4-codex",
          stream: true,
          instructions: "stable instructions",
          prompt_cache_key: "conversation-1",
          input: [firstUser] as never,
        },
        lastResponse: {
          responseId: "resp_1",
          outputItems: [assistantOutput] as never,
        },
      },
    );

    expect(outbound.previous_response_id).toBe("resp_1");
    expect(outbound.input as unknown).toEqual([secondUser]);
  });

  test("SSE transport sends full transcript because previous response ids are websocket-only", async () => {
    const originalFetch = globalThis.fetch;
    const requests: RequestBody[] = [];
    const firstUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "First turn" }],
      timestamp: 1,
    };
    const secondUser = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Second turn" }],
      timestamp: 3,
    };

    const responses = [
      createSseResponse([
        {
          type: "response.created",
          response: { id: "resp_sse_1" },
        },
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "msg_sse_1",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        },
        {
          type: "response.content_part.added",
          item_id: "msg_sse_1",
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_sse_1",
          delta: "First answer",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "msg_sse_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "First answer", annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_sse_1",
            status: "completed",
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ]),
      createSseResponse([
        {
          type: "response.completed",
          response: {
            id: "resp_sse_2",
            status: "completed",
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              total_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ]),
    ];

    globalThis.fetch = (async (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Codex SSE request body to be a JSON string");
      }
      requests.push(JSON.parse(body) as RequestBody);
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected fetch call");
      }
      return response;
    }) as typeof fetch;

    clearCodexSessionState("session-sse-continuation");
    try {
      const firstEvents = await collectProviderEvents(
        streamOpenAICodexResponses(
          CODEX_MODEL,
          { systemPrompt: "stable instructions", messages: [firstUser] },
          {
            apiKey: createFakeCodexToken(),
            sessionId: "session-sse-continuation",
            transport: "sse",
          },
        ),
      );
      const firstDone = firstEvents.find((event) => event.type === "done");
      if (!firstDone || firstDone.type !== "done") {
        throw new Error("Expected first stream to complete");
      }

      await collectProviderEvents(
        streamOpenAICodexResponses(
          CODEX_MODEL,
          {
            systemPrompt: "changed instructions",
            messages: [firstUser, firstDone.message, secondUser],
          },
          {
            apiKey: createFakeCodexToken(),
            sessionId: "session-sse-continuation",
            transport: "sse",
          },
        ),
      );

      expect(requests).toHaveLength(2);
      const secondRequest = requests[1];
      if (!secondRequest) {
        throw new Error("Expected second Codex SSE request");
      }
      expect("previous_response_id" in secondRequest).toBe(false);
      expect(secondRequest.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_text", text: "First turn" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First answer", annotations: [] }],
          status: "completed",
          id: "msg_sse_1",
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "Second turn" }],
        },
      ]);
    } finally {
      clearCodexSessionState("session-sse-continuation");
      globalThis.fetch = originalFetch;
    }
  });

  test("does not reuse continuation state across model switches", () => {
    const firstUser = {
      role: "user",
      content: [{ type: "input_text", text: "First turn" }],
    };
    const secondUser = {
      role: "user",
      content: [{ type: "input_text", text: "Second turn" }],
    };
    const assistantOutput = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "First answer", annotations: [] }],
    };
    const fullInput = [firstUser, assistantOutput, secondUser];

    const outbound = buildCodexContinuationRequest(
      {
        model: "gpt-5.4",
        stream: true,
        instructions: "stable instructions",
        prompt_cache_key: "conversation-1",
        input: fullInput as never,
      },
      {
        model: "gpt-5.4-mini",
        previousRequest: {
          model: "gpt-5.4",
          stream: true,
          instructions: "stable instructions",
          prompt_cache_key: "conversation-1",
          input: [firstUser] as never,
        },
        lastResponse: {
          responseId: "resp_1",
          outputItems: [assistantOutput] as never,
        },
      } as never,
    );

    expect(outbound.previous_response_id).toBe(undefined);
    expect(outbound.input as unknown).toEqual(fullInput);
  });
});
