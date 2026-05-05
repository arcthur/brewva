import { describe, expect, test } from "bun:test";
import { buildAnthropicParams } from "../../../packages/brewva-provider-core/src/providers/anthropic/request.js";

const TEST_MODEL = {
  provider: "anthropic",
  id: "claude-4-sonnet",
  name: "Claude 4 Sonnet",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 200000,
  maxTokens: 8192,
};

const KIMI_CODE_MODEL = {
  ...TEST_MODEL,
  provider: "kimi-coding",
  id: "kimi-for-coding",
  name: "Kimi For Coding",
  baseUrl: "https://api.kimi.com/coding/v1",
};

describe("anthropic cache breakpoints", () => {
  test("allocates cache_control across system, tools, message prefix, and current turn", () => {
    const params = buildAnthropicParams(
      TEST_MODEL as never,
      {
        systemPrompt: "Stable system prompt",
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First turn" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "First answer" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-4-sonnet",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
          {
            role: "user",
            content: [{ type: "text", text: "Second turn" }],
            timestamp: 3,
          },
        ],
      } as never,
      false,
      {
        sessionId: "session-anthropic-cache",
        cachePolicy: {
          retention: "short",
          writeMode: "readWrite",
          scope: "session",
          reason: "default",
        },
      },
    );

    expect(countCacheControl(params)).toBe(4);
    expect(params.system).toEqual([
      expect.objectContaining({ cache_control: { type: "ephemeral" } }),
    ]);
    expect(params.tools?.[0]).toEqual(
      expect.objectContaining({ cache_control: { type: "ephemeral" } }),
    );
    expect(params.messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({ cache_control: { type: "ephemeral" } })],
      }),
    );
    expect(params.messages[2]).toEqual(
      expect.objectContaining({
        role: "user",
        content: [expect.objectContaining({ cache_control: { type: "ephemeral" } })],
      }),
    );
  });

  test("does not apply Anthropic cache_control to Kimi Code", () => {
    const params = buildAnthropicParams(
      KIMI_CODE_MODEL as never,
      {
        systemPrompt: "Stable system prompt",
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "First turn" }],
            timestamp: 1,
          },
        ],
      } as never,
      false,
      {
        sessionId: "session-kimi-code-cache",
        cachePolicy: {
          retention: "short",
          writeMode: "readWrite",
          scope: "session",
          reason: "default",
        },
      },
    );

    expect(countCacheControl(params)).toBe(0);
  });
});

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControl(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  return Object.entries(value).reduce(
    (sum, [key, item]) => sum + (key === "cache_control" ? 1 : countCacheControl(item)),
    0,
  );
}
