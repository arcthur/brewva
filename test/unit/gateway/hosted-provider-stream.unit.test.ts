import { describe, expect, test } from "bun:test";
import { BrewvaEffect, BrewvaStream, runPromiseAtBoundary } from "@brewva/brewva-effect";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { createHostedProviderStreamFunction } from "../../../packages/brewva-gateway/src/host/hosted-provider-stream.js";
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
});
