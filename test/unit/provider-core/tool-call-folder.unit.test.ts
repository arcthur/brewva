import { describe, expect, test } from "bun:test";
import { createAssistantMessage } from "../../../packages/brewva-provider-core/src/streaming/assistant-message.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/streaming/tool-call-folder.js";
import type { Model } from "../../../packages/brewva-provider-core/src/types.js";
import { AssistantMessageEventStream } from "../../../packages/brewva-provider-core/src/utils/event-stream.js";

async function collectEvents(stream: AssistantMessageEventStream) {
  stream.end();
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

const TEST_MODEL: Model<"openai-responses"> = {
  api: "openai-responses",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("incremental tool call folder", () => {
  test("tracks interleaved incremental tool calls without leaking partialJson", async () => {
    const output = createAssistantMessage(TEST_MODEL);
    const stream = new AssistantMessageEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => {});

    folder.begin("call:1", { id: "call_1", name: "search" });
    folder.begin("call:2", { id: "call_2", name: "read" });
    folder.appendArgumentsDelta("call:1", '{"query":"alpha"');
    folder.appendArgumentsDelta("call:2", '{"path":"README');
    folder.replaceArguments("call:1", '{"query":"alpha","limit":2}');
    folder.replaceArguments("call:2", '{"path":"README.md"}');
    folder.finalize("call:2");
    folder.finalize("call:1");

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "toolcall_end",
    ]);
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        name: "search",
        arguments: {
          query: "alpha",
          limit: 2,
        },
      },
      {
        type: "toolCall",
        id: "call_2",
        name: "read",
        arguments: {
          path: "README.md",
        },
      },
    ]);
    expect(JSON.stringify(output.content)).not.toContain("partialJson");
  });

  test("supports atomic tool calls with one shared seam", async () => {
    const output = createAssistantMessage(TEST_MODEL);
    const stream = new AssistantMessageEventStream();
    const folder = new IncrementalToolCallFolder(output, stream, () => {});

    folder.pushAtomic(
      {
        type: "toolCall",
        id: "call_3",
        name: "lookup",
        arguments: { id: 3 },
        thoughtSignature: "sig_3",
      },
      "call:3",
    );

    const events = await collectEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_3",
        name: "lookup",
        arguments: { id: 3 },
        thoughtSignature: "sig_3",
      },
    ]);
  });
});
