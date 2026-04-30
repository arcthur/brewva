import { describe, expect, test } from "bun:test";
import { getEnvApiKey, getModel, type Context } from "@brewva/brewva-provider-core";
import { Type } from "@sinclair/typebox";
import {
  buildOpenAICompletionsParams,
  convertMessages,
  normalizeOpenAICompletionsUsage,
  resolveOpenAICompletionsCompat,
  streamOpenAICompletions,
} from "../../../packages/brewva-provider-core/src/providers/openai-completions.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

const DEEPSEEK_MODEL = getModel("deepseek", "deepseek-v4-flash");

function userText(text: string): Context["messages"][number] {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

describe("OpenAI completions DeepSeek compatibility", () => {
  test("reads DeepSeek credentials only from explicit discovery input", () => {
    const restoreEnv = patchProcessEnv({
      DEEPSEEK_API_KEY: "ambient-deepseek-key-must-not-be-used",
    });
    try {
      expect(
        getEnvApiKey("deepseek", {
          DEEPSEEK_API_KEY: "explicit-discovery-key",
        }),
      ).toBe("explicit-discovery-key");
    } finally {
      restoreEnv();
    }
  });

  test("fails closed on DeepSeek auth instead of falling back to OPENAI_API_KEY", async () => {
    const restoreEnv = patchProcessEnv({
      DEEPSEEK_API_KEY: undefined,
      OPENAI_API_KEY: "openai-key-must-not-be-used",
    });
    try {
      const stream = streamOpenAICompletions(DEEPSEEK_MODEL, {
        systemPrompt: "You are concise.",
        messages: [userText("Say hi.")],
      });

      const result = await stream.result();

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("No API key for provider: deepseek");
    } finally {
      restoreEnv();
    }
  });

  test("builds non-thinking DeepSeek payloads without inherited OpenAI or cache-only fields", () => {
    const params = buildOpenAICompletionsParams(
      DEEPSEEK_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [userText("Say hi.")],
        tools: [
          {
            name: "lookup",
            description: "Look up a value.",
            parameters: Type.Object({ id: Type.String() }),
          },
        ],
      },
      {
        maxTokens: 128,
        temperature: 0.2,
      },
    ) as unknown as Record<string, unknown>;

    expect(params).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      max_tokens: 128,
      temperature: 0.2,
      thinking: { type: "disabled" },
      stream_options: { include_usage: true },
    });
    expect(params.max_completion_tokens).toBeUndefined();
    expect(params.store).toBeUndefined();
    expect(params.prompt_cache_key).toBeUndefined();
    expect(params.cache_control).toBeUndefined();
    expect(params.reasoning_effort).toBeUndefined();
    expect((params.messages as Array<{ role: string }>)[0]?.role).toBe("system");
    expect(JSON.stringify(params.tools)).not.toContain('"strict"');
  });

  test("builds thinking DeepSeek payloads with provider-native reasoning effort", () => {
    const mediumParams = buildOpenAICompletionsParams(
      DEEPSEEK_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [userText("Think briefly.")],
      },
      {
        maxTokens: 128,
        reasoningEffort: "medium",
      },
    ) as unknown as Record<string, unknown>;
    const xhighParams = buildOpenAICompletionsParams(
      DEEPSEEK_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [userText("Think briefly.")],
      },
      {
        maxTokens: 128,
        temperature: 0.2,
        reasoningEffort: "xhigh",
      },
    ) as unknown as Record<string, unknown>;

    expect(mediumParams).toMatchObject({
      max_tokens: 128,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
    expect(xhighParams).toMatchObject({
      max_tokens: 128,
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(xhighParams.temperature).toBeUndefined();
  });

  test("preserves DeepSeek reasoning content only for tool-call assistant turns", () => {
    const compat = resolveOpenAICompletionsCompat(DEEPSEEK_MODEL);
    const messages = convertMessages(
      DEEPSEEK_MODEL,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-completions",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            content: [
              {
                type: "thinking",
                thinking: "private ordinary thought",
                thinkingSignature: "reasoning_content",
              },
              { type: "text", text: "Done." },
            ],
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
          },
          {
            role: "assistant",
            api: "openai-completions",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            content: [
              {
                type: "thinking",
                thinking: "tool decision",
                thinkingSignature: "reasoning_content",
              },
              { type: "toolCall", id: "call_1", name: "lookup", arguments: { id: "a" } },
            ],
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
          },
        ],
      },
      compat,
    );

    const assistantMessages = messages.filter(
      (message) => message.role === "assistant",
    ) as unknown as Array<Record<string, unknown>>;
    expect(assistantMessages[0]?.reasoning_content).toBeUndefined();
    expect(assistantMessages[1]?.reasoning_content).toBe("tool decision");
  });

  test("normalizes DeepSeek cache hit and miss token counters without double-counting reasoning", () => {
    const usage = normalizeOpenAICompletionsUsage(
      {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 400,
        completion_tokens_details: {
          reasoning_tokens: 200,
        },
      },
      DEEPSEEK_MODEL,
    );

    expect(usage).toMatchObject({
      input: 400,
      output: 300,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 1500,
    });
    expect(usage.cost.input).toBeCloseTo(0.000056);
    expect(usage.cost.output).toBeCloseTo(0.000084);
    expect(usage.cost.cacheRead).toBeCloseTo(0.00000224);
    expect(usage.cost.cacheWrite).toBe(0);
    expect(usage.cost.total).toBeCloseTo(0.00014224);
  });

  test("keeps DeepSeek fallback usage from double-counting reasoning when native cache counters are absent", () => {
    const usage = normalizeOpenAICompletionsUsage(
      {
        prompt_tokens: 1000,
        completion_tokens: 120,
        total_tokens: 1120,
        prompt_tokens_details: {
          cached_tokens: 250,
          cache_write_tokens: 25,
        },
        completion_tokens_details: {
          reasoning_tokens: 50,
        },
      },
      DEEPSEEK_MODEL,
    );

    expect(usage).toMatchObject({
      input: 750,
      output: 120,
      cacheRead: 250,
      cacheWrite: 0,
      totalTokens: 1120,
    });
  });
});
