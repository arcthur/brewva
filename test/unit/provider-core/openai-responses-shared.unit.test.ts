import { describe, expect, test } from "bun:test";
import {
  convertResponsesMessages,
  processResponsesStream,
} from "../../../packages/brewva-provider-core/src/providers/openai-responses-shared.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/streaming/tool-call-folder.js";
import type { AssistantMessage } from "../../../packages/brewva-provider-core/src/types.js";
import { AssistantMessageEventStream } from "../../../packages/brewva-provider-core/src/utils/event-stream.js";

function createTestToolCalls(
  output: unknown,
  stream: AssistantMessageEventStream,
): IncrementalToolCallFolder {
  return new IncrementalToolCallFolder(output as AssistantMessage, stream, () => {});
}

const TEST_MODEL = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"] as Array<"text" | "image">,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

describe("openai responses prompt file conversion", () => {
  test("sends resolved text files through native input_file blocks", () => {
    const messages = convertResponsesMessages(
      TEST_MODEL,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Review this file.\n" },
              {
                type: "file",
                uri: "file:///tmp/workspace/src/example.ts",
                displayText: "@src/example.ts",
                name: "example.ts",
              },
            ],
            timestamp: 1,
          } as never,
        ],
      },
      new Set(["openai"]),
      { includeSystemPrompt: false } as never,
      {
        resolveFile(part: { uri: string; name?: string }) {
          expect(part.uri).toBe("file:///tmp/workspace/src/example.ts");
          expect(part.name).toBe("example.ts");
          return {
            kind: "text",
            uri: part.uri,
            name: part.name,
            mimeType: "text/typescript",
            text: "export const answer = 42;\n",
          };
        },
      } as never,
    );

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Review this file.\n",
          },
          {
            type: "input_file",
            filename: "example.ts",
            file_data: Buffer.from("export const answer = 42;\n", "utf8").toString("base64"),
          },
        ],
      },
    ]);
  });
});

describe("openai responses stream processing", () => {
  test("streams Codex reasoning summary deltas when summary part events omit part payloads", async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const stream = new AssistantMessageEventStream();
    const observed: Array<{ type: string; delta?: string }> = [];
    const push = stream.push.bind(stream);
    stream.push = (event) => {
      observed.push(event);
      push(event);
    };

    await processResponsesStream(
      [
        {
          type: "response.created",
          response: { id: "resp_1" },
        },
        {
          type: "response.output_item.added",
          item: { id: "rs_1", type: "reasoning", summary: [] },
        },
        {
          type: "response.reasoning_summary_part.added",
          item_id: "rs_1",
          summary_index: 0,
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: "Step",
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: " one",
        },
        {
          type: "response.output_item.done",
          item: {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Step one" }],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            usage: {
              input_tokens: 1,
              output_tokens: 2,
              total_tokens: 3,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        },
      ] as never,
      output as never,
      stream,
      TEST_MODEL as never,
      createTestToolCalls(output, stream),
    );

    expect(
      observed.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ).toEqual(["Step", " one"]);
    expect(output.content).toMatchObject([
      {
        type: "thinking",
        thinking: "Step one",
      },
    ]);
  });

  test("does not leak partialJson working state into final tool call output", async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const stream = new AssistantMessageEventStream();

    await processResponsesStream(
      [
        {
          type: "response.output_item.added",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "search",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          delta: '{"query":"needle"',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: '{"query":"needle","limit":2}',
        },
        {
          type: "response.output_item.done",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "search",
            arguments: '{"query":"needle","limit":2}',
          },
        },
      ] as never,
      output as never,
      stream,
      TEST_MODEL as never,
      createTestToolCalls(output, stream),
    );

    expect(output.content as unknown[]).toEqual([
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "search",
        arguments: {
          query: "needle",
          limit: 2,
        },
      },
    ]);
    expect(JSON.stringify(output.content)).not.toContain("partialJson");
  });

  test("routes interleaved function_call argument deltas by item_id", async () => {
    const output = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    const stream = new AssistantMessageEventStream();

    await processResponsesStream(
      [
        {
          type: "response.output_item.added",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "search",
            arguments: "",
          },
        },
        {
          type: "response.output_item.added",
          item: {
            id: "fc_2",
            call_id: "call_2",
            type: "function_call",
            name: "read",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          delta: '{"query":"alpha"',
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_2",
          delta: '{"path":"README',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          arguments: '{"query":"alpha","limit":2}',
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_2",
          arguments: '{"path":"README.md"}',
        },
        {
          type: "response.output_item.done",
          item: {
            id: "fc_2",
            call_id: "call_2",
            type: "function_call",
            name: "read",
            arguments: '{"path":"README.md"}',
          },
        },
        {
          type: "response.output_item.done",
          item: {
            id: "fc_1",
            call_id: "call_1",
            type: "function_call",
            name: "search",
            arguments: '{"query":"alpha","limit":2}',
          },
        },
      ] as never,
      output as never,
      stream,
      TEST_MODEL as never,
      createTestToolCalls(output, stream),
    );

    expect(output.content as unknown[]).toEqual([
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "search",
        arguments: {
          query: "alpha",
          limit: 2,
        },
      },
      {
        type: "toolCall",
        id: "call_2|fc_2",
        name: "read",
        arguments: {
          path: "README.md",
        },
      },
    ]);
  });
});
