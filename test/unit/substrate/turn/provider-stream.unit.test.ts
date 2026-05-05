import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { createAssistantMessageEventStream } from "@brewva/brewva-provider-core/stream";
import { createBrewvaTurnProviderStreamFunction } from "@brewva/brewva-substrate/turn";

const SOURCE_ID = "provider-stream-unit-test";

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

describe("substrate turn provider stream", () => {
  test("preserves advisory parse status from provider-core event contract", async () => {
    clearApiProviders();
    registerApiProvider(
      {
        api: "engine-provider-stream-test",
        stream() {
          const stream = createAssistantMessageEventStream();
          return stream;
        },
        streamSimple(model) {
          const stream = createAssistantMessageEventStream();
          const partial = createMessage(model.api);
          queueMicrotask(() => {
            stream.push({ type: "start", partial });
            stream.push({
              type: "toolcall_start",
              contentIndex: 0,
              partial,
              parseStatus: "incomplete",
            });
            stream.push({
              type: "toolcall_delta",
              contentIndex: 0,
              delta: '{"query"',
              partial,
              parseStatus: "pending",
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "call_1", name: "search", arguments: {} },
              partial,
              parseStatus: "likely_invalid",
            });
            stream.push({ type: "done", reason: "toolUse", message: partial });
            stream.end(partial);
          });
          return stream;
        },
      },
      SOURCE_ID,
    );

    const providerStream = createBrewvaTurnProviderStreamFunction();
    const stream = await providerStream(
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

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events[1]).toMatchObject({ type: "toolcall_start", parseStatus: "incomplete" });
    expect(events[2]).toMatchObject({ type: "toolcall_delta", parseStatus: "pending" });
    expect(events[3]).toMatchObject({ type: "toolcall_end", parseStatus: "likely_invalid" });

    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  });
});
