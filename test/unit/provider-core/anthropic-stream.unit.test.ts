import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Tool } from "@brewva/brewva-provider-core/contracts";
import { Type } from "@sinclair/typebox";
import { processAnthropicStream } from "../../../packages/brewva-provider-core/src/providers/anthropic/stream-events.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/stream/tool-call-folder.js";
import {
  createRecordingProviderEventStream,
  type RecordingProviderEventStream,
} from "../../helpers/effect-stream.js";

function createTestToolCalls(
  output: AssistantMessage,
  stream: RecordingProviderEventStream,
): IncrementalToolCallFolder {
  return new IncrementalToolCallFolder(output, stream, async () => {});
}

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function collectQueuedEvents(stream: RecordingProviderEventStream) {
  await stream.end();
  return stream.events;
}

describe("anthropic stream processor", () => {
  test("folds thinking, OAuth tool names, partial JSON, and usage without leaking private fields", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();
    const tools: Tool[] = [
      {
        name: "grep",
        description: "grep",
        parameters: Type.Object({}),
      },
    ];

    await processAnthropicStream(
      (async function* () {
        yield {
          type: "message_start",
          message: {
            id: "msg_1",
            usage: {
              input_tokens: 10,
              output_tokens: 1,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 3,
            },
          },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "pondering",
          },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "signature_delta",
            signature: "sig_1",
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
        yield {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool_1",
            name: "Grep",
            input: {},
          },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"query":"needle"',
          },
        };
        yield {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: ',"limit":2}',
          },
        };
        yield {
          type: "content_block_stop",
          index: 1,
        };
        yield {
          type: "message_delta",
          delta: {
            stop_reason: "tool_use",
          },
          usage: {
            input_tokens: 11,
            output_tokens: 4,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
        };
      })(),
      output,
      stream,
      {
        api: "anthropic-messages",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      createTestToolCalls(output, stream),
      {
        isOAuth: true,
        tools,
      },
    );

    const events = await collectQueuedEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(output.responseId).toBe("msg_1");
    expect(output.stopReason).toBe("toolUse");
    expect(output.usage.totalTokens).toBe(20);
    expect(output.content).toEqual([
      {
        type: "thinking",
        thinking: "pondering",
        thinkingSignature: "sig_1",
      },
      {
        type: "toolCall",
        id: "tool_1",
        name: "grep",
        arguments: {
          query: "needle",
          limit: 2,
        },
      },
    ]);
    expect(JSON.stringify(output.content)).not.toContain("partialJson");
    expect(JSON.stringify(output.content)).not.toContain('"index"');
  });

  test("preserves redacted thinking blocks", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    await processAnthropicStream(
      (async function* () {
        yield {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "redacted_thinking",
            data: "redacted_sig",
          },
        };
        yield {
          type: "content_block_stop",
          index: 0,
        };
      })(),
      output,
      stream,
      {
        api: "anthropic-messages",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      createTestToolCalls(output, stream),
      {
        isOAuth: false,
      },
    );

    await collectQueuedEvents(stream);
    expect(output.content[0]).toEqual({
      type: "thinking",
      thinking: "[Reasoning redacted]",
      thinkingSignature: "redacted_sig",
      redacted: true,
    });
  });
});
