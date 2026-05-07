import { describe, expect, test } from "bun:test";
import type { Model } from "@brewva/brewva-provider-core/contracts";
import {
  resolveCodexTransport,
  shouldAttemptCodexWebSocketTransport,
} from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/adapter.js";
import { buildCodexContinuationRequest } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/request.js";
import { processWebSocketStream } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/websocket.js";
import {
  clearCodexSessionState,
  getCodexSessionCacheState,
  isCodexWebSocketFallbackActive,
  rememberCachedWebSocketConnection,
  rememberCodexContinuationState,
  recordCodexWebSocketFallback,
} from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/websocket.js";
import { createAssistantMessage } from "../../../packages/brewva-provider-core/src/stream/assistant-message.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/stream/tool-call-folder.js";
import { createRecordingProviderEventStream } from "../../helpers/effect-stream.js";

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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected websocket ${index} to send a request`);
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

  test("falls back to a full request when non-input request shape drifts", () => {
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

    expect(outbound.previous_response_id).toBeUndefined();
    expect(outbound.input as unknown).toEqual(fullInput);
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

    expect(outbound.previous_response_id).toBeUndefined();
    expect(outbound.input as unknown).toEqual(fullInput);
  });
});
