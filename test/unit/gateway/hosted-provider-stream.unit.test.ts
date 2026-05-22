import { describe, expect, test } from "bun:test";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaStream } from "@brewva/brewva-effect/primitives";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { createHostedProviderStreamFunction } from "../../../packages/brewva-gateway/src/hosted/internal/provider/stream.js";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";

const SOURCE_ID = "hosted-provider-stream-unit-test";

function createMessage(api: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: "unit-provider",
    model: "unit-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

describe("hosted provider stream", () => {
  test("preserves advisory parse status from provider-core event contract", async () => {
    clearApiProviders();
    registerApiProvider(
      {
        api: "engine-provider-stream-test",
        stream() {
          return createProviderEventStream();
        },
        streamSimple(model) {
          const partial = createMessage(model.api);
          return createProviderEventStream([
            { type: "start", partial },
            {
              type: "toolcall_start",
              contentIndex: 0,
              partial,
              parseStatus: "incomplete",
            },
            {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: '{"query"',
              partial,
              parseStatus: "pending",
            },
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "call_1", name: "search", arguments: {} },
              partial,
              parseStatus: "likely_invalid",
            },
            { type: "done", reason: "toolUse", message: partial },
          ]);
        },
      },
      SOURCE_ID,
    );

    const providerStream = createHostedProviderStreamFunction();
    const stream = providerStream(
      {
        provider: "unit-provider",
        id: "unit-model",
        name: "Unit Model",
        api: "engine-provider-stream-test",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      {
        systemPrompt: "test",
        messages: [],
      },
      {
        reasoning: "off",
      },
    );

    const events = await runPromiseAtBoundary(
      stream.pipe(BrewvaStream.runCollect, BrewvaEffect.provide(providerRuntimeLayer)),
    );

    expect(events[1]).toMatchObject({ type: "toolcall_start", parseStatus: "incomplete" });
    expect(events[2]).toMatchObject({ type: "toolcall_delta", parseStatus: "pending" });
    expect(events[3]).toMatchObject({ type: "toolcall_end", parseStatus: "likely_invalid" });

    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  });

  test("converts runtime prompt tool-call messages before tool results", async () => {
    let observedMessages: unknown;
    clearApiProviders();
    registerApiProvider(
      {
        api: "runtime-provider-context-test",
        stream() {
          return createProviderEventStream();
        },
        streamSimple(_model, context) {
          observedMessages = context.messages;
          return createProviderEventStream();
        },
      },
      SOURCE_ID,
    );

    const session = {
      model: {
        provider: "unit-provider",
        id: "unit-model",
        name: "Unit Model",
        api: "runtime-provider-context-test",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const, apiKey: "unit-key" };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
    };

    const provider = createHostedRuntimeProviderPort(session as never);
    for await (const _frame of provider.stream({
      turn: { sessionId: "session-1", prompt: "next" },
      prompt: {
        status: "ready",
        sessionId: "session-1",
        messages: [
          { role: "user", content: "find docs" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                toolCallId: "call-1",
                toolName: "grep",
                args: { query: "architecture" },
              },
            ],
          },
          {
            role: "tool",
            content: "docs/architecture/system-architecture.md",
            toolCallId: "call-1",
            toolName: "grep",
            isError: false,
          },
        ],
        admittedBlocks: [],
        droppedAdvisoryBlocks: [],
        tokenEstimate: 0,
        cache: { stablePrefix: false },
      },
    })) {
    }

    expect(observedMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "find docs" }],
        timestamp: expect.any(Number),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "grep",
            arguments: { query: "architecture" },
          },
        ],
        api: "faux",
        provider: "faux",
        model: "runtime-adapter-history",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: expect.any(Number),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "grep",
        content: [{ type: "text", text: "docs/architecture/system-architecture.md" }],
        isError: false,
        timestamp: expect.any(Number),
      },
    ]);

    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  });
});
