import { describe, expect, test } from "bun:test";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import { processOpenAICompletionsStream } from "../../../packages/brewva-provider-core/src/providers/openai-completions/stream-events.js";
import { IncrementalToolCallFolder } from "../../../packages/brewva-provider-core/src/stream/tool-call-folder.js";
import {
  createRecordingProviderEventStream,
  runProviderCoreEffect,
  type RecordingProviderEventStream,
} from "../../helpers/effect-stream.js";

function createTestToolCalls(
  output: AssistantMessage,
  stream: RecordingProviderEventStream,
): IncrementalToolCallFolder {
  return new IncrementalToolCallFolder(output, stream, () => BrewvaEffect.void);
}

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o",
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
  await runProviderCoreEffect(stream.end());
  return stream.events;
}

describe("openai completions stream processor", () => {
  test("folds text, reasoning, tool calls, reasoning details, and usage without leaking partial args", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    await runProviderCoreEffect(
      processOpenAICompletionsStream(
        (async function* () {
          yield {
            id: "resp_1",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            usage: {
              prompt_tokens: 12,
              completion_tokens: 2,
              total_tokens: 14,
            },
            choices: [
              {
                delta: {
                  content: "Hello",
                },
              },
            ],
          };
          yield {
            id: "resp_1",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  reasoning: "Need tool",
                },
              },
            ],
          };
          yield {
            id: "resp_1",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "search",
                        arguments: '{"query":"needle"',
                      },
                    },
                  ],
                },
              },
            ],
          };
          yield {
            id: "resp_1",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        arguments: ',"limit":3}',
                      },
                    },
                  ],
                  reasoning_details: [
                    {
                      type: "reasoning.encrypted",
                      id: "call_1",
                      data: "encrypted",
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
        })() as unknown as AsyncIterable<any>,
        output,
        stream,
        {
          api: "openai-completions",
          id: "gpt-4o",
          name: "GPT-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        createTestToolCalls(output, stream),
      ),
    );

    const events = await collectQueuedEvents(stream);
    expect(events.map((event) => event.type)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(output.responseId).toBe("resp_1");
    expect(output.stopReason).toBe("toolUse");
    expect(output.usage.totalTokens).toBe(14);
    expect(output.content).toEqual([
      {
        type: "text",
        text: "Hello",
      },
      {
        type: "thinking",
        thinking: "Need tool",
        thinkingSignature: "reasoning",
      },
      {
        type: "toolCall",
        id: "call_1",
        name: "search",
        arguments: {
          query: "needle",
          limit: 3,
        },
        thoughtSignature: JSON.stringify({
          type: "reasoning.encrypted",
          id: "call_1",
          data: "encrypted",
        }),
      },
    ]);
    expect(JSON.stringify(output.content)).not.toContain("partialArgs");
  });

  test("uses choice usage fallback and preserves provider error stop reason", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    await runProviderCoreEffect(
      processOpenAICompletionsStream(
        (async function* () {
          yield {
            id: "resp_2",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {},
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 1,
                  total_tokens: 6,
                },
                finish_reason: "content_filter",
              },
            ],
          };
        })() as unknown as AsyncIterable<any>,
        output,
        stream,
        {
          api: "openai-completions",
          id: "gpt-4o",
          name: "GPT-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        createTestToolCalls(output, stream),
      ),
    );

    await collectQueuedEvents(stream);
    expect(output.usage.totalTokens).toBe(6);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe("Provider finish_reason: content_filter");
  });

  test("surfaces routed chunk model without changing the requested model", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    await runProviderCoreEffect(
      processOpenAICompletionsStream(
        (async function* () {
          yield {
            id: "resp_routed",
            created: 1,
            model: "anthropic/claude-opus-4.8",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  content: "Hello",
                },
              },
            ],
          };
          yield {
            id: "resp_routed",
            created: 1,
            model: "anthropic/claude-opus-4.8",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
        })() as unknown as AsyncIterable<any>,
        output,
        stream,
        {
          api: "openai-completions",
          id: "gpt-4o",
          name: "GPT-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        createTestToolCalls(output, stream),
      ),
    );

    await collectQueuedEvents(stream);
    expect(output.model).toBe("gpt-4o");
    expect(output.responseModel).toBe("anthropic/claude-opus-4.8");
  });

  test("routes interleaved tool call deltas by tool-call index instead of current block", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    await runProviderCoreEffect(
      processOpenAICompletionsStream(
        (async function* () {
          yield {
            id: "resp_3",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: {
                        name: "search",
                        arguments: '{"query":"alpha"',
                      },
                    },
                    {
                      index: 1,
                      id: "call_2",
                      function: {
                        name: "read",
                        arguments: '{"path":"README',
                      },
                    },
                  ],
                },
              },
            ],
          };
          yield {
            id: "resp_3",
            created: 1,
            model: "gpt-4o",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: ',"limit":2}',
                      },
                    },
                    {
                      index: 1,
                      function: {
                        arguments: '.md"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
        })() as unknown as AsyncIterable<any>,
        output,
        stream,
        {
          api: "openai-completions",
          id: "gpt-4o",
          name: "GPT-4o",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        createTestToolCalls(output, stream),
      ),
    );

    await collectQueuedEvents(stream);
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
  });

  test("rejects streams that end without a terminal finish_reason", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    let thrown: unknown;
    try {
      await runProviderCoreEffect(
        processOpenAICompletionsStream(
          (async function* () {
            yield {
              id: "resp_truncated",
              created: 1,
              model: "gpt-4o",
              object: "chat.completion.chunk",
              choices: [
                {
                  delta: {
                    content: "partial answer",
                  },
                },
              ],
            };
          })() as unknown as AsyncIterable<any>,
          output,
          stream,
          {
            api: "openai-completions",
            id: "gpt-4o",
            name: "GPT-4o",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          createTestToolCalls(output, stream),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Stream ended without finish_reason");
  });

  test("does not finalize tool calls when a stream ends without finish_reason", async () => {
    const output = createOutput();
    const stream = createRecordingProviderEventStream();

    let thrown: unknown;
    try {
      await runProviderCoreEffect(
        processOpenAICompletionsStream(
          (async function* () {
            yield {
              id: "resp_truncated_tool",
              created: 1,
              model: "gpt-4o",
              object: "chat.completion.chunk",
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: "call_1",
                        function: {
                          name: "search",
                          arguments: '{"query":"alpha"}',
                        },
                      },
                    ],
                  },
                },
              ],
            };
          })() as unknown as AsyncIterable<any>,
          output,
          stream,
          {
            api: "openai-completions",
            id: "gpt-4o",
            name: "GPT-4o",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            reasoning: true,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          createTestToolCalls(output, stream),
        ),
      );
    } catch (error) {
      thrown = error;
    }

    const events = await collectQueuedEvents(stream);
    expect(thrown).toBeInstanceOf(Error);
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
  });
});
