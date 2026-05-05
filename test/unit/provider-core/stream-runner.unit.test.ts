import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Model } from "@brewva/brewva-provider-core/contracts";
import { runProviderStream } from "../../../packages/brewva-provider-core/src/stream/run-provider-stream.js";

const model: Model<"openai-responses"> = {
  id: "gpt-4o",
  name: "GPT-4o",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 4096,
};

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("provider stream runner", () => {
  test("finishes composer-owned text and tool call blocks before done", async () => {
    const stream = runProviderStream(model, async (session) => {
      session.composer.blocks.appendText("hello");
      session.composer.toolCalls.begin("call", {
        id: "call_1",
        name: "search",
        arguments: {},
      });
      session.composer.toolCalls.appendArgumentsDelta("call", '{"query":"needle"}');
      session.output.stopReason = "toolUse";
    });

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "text_end",
      "toolcall_end",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "toolUse",
    });
  });
});
