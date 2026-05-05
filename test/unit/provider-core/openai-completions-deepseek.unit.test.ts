import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@brewva/brewva-provider-core/auth";
import { getModel } from "@brewva/brewva-provider-core/catalog";
import type { Context, Model } from "@brewva/brewva-provider-core/contracts";
import { Type } from "@sinclair/typebox";
import { buildOpenAICompletionsDefaultHeaders } from "../../../packages/brewva-provider-core/src/providers/openai-completions/adapter.js";
import {
  buildOpenAICompletionsParams,
  convertMessages,
  normalizeOpenAICompletionsUsage,
  resolveOpenAICompletionsCompat,
  streamOpenAICompletions,
} from "../../../packages/brewva-provider-core/src/providers/openai-completions/index.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

const DEEPSEEK_MODEL = getModel("deepseek", "deepseek-v4-flash");
const OPENAI_COMPLETIONS_MODEL: Model<"openai-completions"> = {
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
};
const OPENROUTER_ANTHROPIC_MODEL: Model<"openai-completions"> = {
  api: "openai-completions",
  id: "anthropic/claude-sonnet-4.5",
  name: "Claude Sonnet 4.5",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

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

  test("adds direct OpenAI prompt cache fields to completions payloads", () => {
    const params = buildOpenAICompletionsParams(
      OPENAI_COMPLETIONS_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [userText("Say hi.")],
      },
      {
        sessionId: "session-openai-completions",
        cachePolicy: {
          retention: "long",
          writeMode: "readWrite",
          scope: "session",
          reason: "config",
        },
      },
    ) as unknown as Record<string, unknown>;

    expect(params.prompt_cache_key).toBe("session-openai-completions");
    expect(params.prompt_cache_retention).toBe("24h");
  });

  test("omits OpenAI prompt cache retention when compat disables long retention", () => {
    const params = buildOpenAICompletionsParams(
      {
        ...OPENAI_COMPLETIONS_MODEL,
        compat: { supportsLongCacheRetention: false },
      },
      {
        systemPrompt: "You are concise.",
        messages: [userText("Say hi.")],
      },
      {
        sessionId: "session-openai-short-compat",
        cachePolicy: {
          retention: "long",
          writeMode: "readWrite",
          scope: "session",
          reason: "config",
        },
      },
    ) as unknown as Record<string, unknown>;

    expect(params.prompt_cache_key).toBe("session-openai-short-compat");
    expect(params.prompt_cache_retention).toBeUndefined();
  });

  test("adds completions session affinity headers only when compat enables them", () => {
    const defaultCompatHeaders = buildOpenAICompletionsDefaultHeaders(
      OPENAI_COMPLETIONS_MODEL,
      { messages: [] },
      { status: "rendered", promptCacheKey: "session-completions" } as never,
      undefined,
      resolveOpenAICompletionsCompat(OPENAI_COMPLETIONS_MODEL),
      "session-completions",
    );
    const affinityHeaders = buildOpenAICompletionsDefaultHeaders(
      {
        ...OPENAI_COMPLETIONS_MODEL,
        compat: { sendSessionAffinityHeaders: true },
      },
      { messages: [] },
      { status: "rendered", promptCacheKey: "session-completions" } as never,
      {
        "x-session-affinity": "explicit-affinity",
      },
      resolveOpenAICompletionsCompat({
        ...OPENAI_COMPLETIONS_MODEL,
        compat: { sendSessionAffinityHeaders: true },
      }),
      "session-completions",
    );

    expect(defaultCompatHeaders.session_id).toBeUndefined();
    expect(defaultCompatHeaders["x-client-request-id"]).toBeUndefined();
    expect(defaultCompatHeaders["x-session-affinity"]).toBeUndefined();
    expect(affinityHeaders.session_id).toBe("session-completions");
    expect(affinityHeaders["x-client-request-id"]).toBe("session-completions");
    expect(affinityHeaders["x-session-affinity"]).toBe("explicit-affinity");
  });

  test("adds OpenRouter Anthropic cache markers to stable prompt boundaries", () => {
    const params = buildOpenAICompletionsParams(
      OPENROUTER_ANTHROPIC_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [
          userText("Earlier prompt."),
          {
            role: "assistant",
            content: [{ type: "text", text: "Earlier answer." }],
            api: "openai-completions",
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4.5",
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
          userText("Current prompt."),
        ],
        tools: [
          {
            name: "lookup",
            description: "Look up a value.",
            parameters: Type.Object({ id: Type.String() }),
          },
        ],
      },
      {
        sessionId: "session-openrouter-anthropic",
        cachePolicy: {
          retention: "long",
          writeMode: "readWrite",
          scope: "session",
          reason: "config",
        },
      },
    ) as unknown as Record<string, unknown>;

    const messages = params.messages as Array<{ role: string; content?: unknown }>;
    const instruction = messages.find(
      (message) => message.role === "system" || message.role === "developer",
    );
    const currentUser = messages.findLast((message) => message.role === "user");
    const tools = params.tools as Array<{ cache_control?: unknown }>;
    const currentUserContent = currentUser?.content;
    const currentUserParts = Array.isArray(currentUserContent)
      ? (currentUserContent as Array<{
          type?: string;
          text?: string;
          cache_control?: unknown;
        }>)
      : [];

    expect(instruction?.content).toEqual([
      {
        type: "text",
        text: "You are concise.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ]);
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(currentUserParts.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("does not add OpenRouter Anthropic cache markers when cache policy is disabled", () => {
    const params = buildOpenAICompletionsParams(
      OPENROUTER_ANTHROPIC_MODEL,
      {
        systemPrompt: "You are concise.",
        messages: [userText("Say hi.")],
      },
      {
        sessionId: "session-cache-disabled",
        cachePolicy: {
          retention: "none",
          writeMode: "readWrite",
          scope: "session",
          reason: "config",
        },
      },
    ) as unknown as Record<string, unknown>;

    expect(JSON.stringify(params)).not.toContain("cache_control");
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
