import { describe, expect, test } from "bun:test";
import {
  estimateModelTokens,
  estimateProviderPayloadTextTokens,
  estimateStructuredTokenCount,
  estimateTokenCount,
  resolveCachePosture,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
  truncateTextToTokenBudget,
} from "@brewva/brewva-token-estimation";
import { countTokens as countCl100kTokens } from "gpt-tokenizer/encoding/cl100k_base";
import { countTokens as countO200kTokens } from "gpt-tokenizer/encoding/o200k_base";

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("token estimation", () => {
  test("uses o200k_base for modern OpenAI-family models", () => {
    const text = "這是一個測試，用於 tokenization。";
    const estimate = estimateModelTokens(text, {
      api: "openai-responses",
      modelId: "gpt-4o",
    });

    expect(estimate).toMatchObject({
      tokens: countO200kTokens(text),
      method: "gpt_bpe",
      encoding: "o200k_base",
      approximation: false,
    });
    expect(estimate.tokens).not.toBe(countCl100kTokens(text));
  });

  test("uses cl100k_base for legacy OpenAI models", () => {
    const text = "legacy model token accounting";
    const estimate = estimateModelTokens(text, {
      api: "openai-completions",
      modelId: "gpt-3.5-turbo",
    });

    expect(estimate).toMatchObject({
      tokens: countCl100kTokens(text),
      method: "gpt_bpe",
      encoding: "cl100k_base",
      approximation: false,
    });
  });

  test("marks non-OpenAI models as BPE approximation instead of heuristic fallback", () => {
    const text = "abcdefghij";
    const estimate = estimateModelTokens(text, {
      api: "google-gemini-cli",
      modelId: "gemini-2.5-pro",
    });

    expect(estimate).toMatchObject({
      tokens: countO200kTokens(text),
      method: "gpt_bpe_approximation",
      encoding: "o200k_base",
      approximation: true,
    });
    expect(estimate.tokens).not.toBe(Math.ceil(text.length / 3.5));
  });

  test("truncates OpenAI text to stay within token budget", () => {
    const text = "reasoning ".repeat(128);
    const truncated = truncateTextToTokenBudget(text, 24, {
      api: "openai-responses",
      modelId: "gpt-4o",
    });
    expect(truncated.length).toBeLessThan(text.length);
    expect(
      estimateTokenCount(truncated, {
        api: "openai-responses",
        modelId: "gpt-4o",
      }),
    ).toBeLessThanOrEqual(24);
  });

  test("truncates emoji without returning invalid unicode", () => {
    const text = "😀".repeat(10);
    for (let budget = 1; budget <= 10; budget += 1) {
      const truncated = truncateTextToTokenBudget(text, budget, {
        api: "openai-responses",
        modelId: "gpt-4o",
      });
      expect(hasUnpairedSurrogate(truncated)).toBe(false);
      expect(
        estimateTokenCount(truncated, {
          api: "openai-responses",
          modelId: "gpt-4o",
        }),
      ).toBeLessThanOrEqual(budget);
    }
  });

  test("normalizes percentage point telemetry and token fallback consistently", () => {
    expect(normalizePercent(82)).toBe(0.82);
    expect(resolveContextUsageRatio({ percent: null, tokens: 240, contextWindow: 400 })).toBe(0.6);
    expect(resolveContextUsageTokens({ percent: 0.25, contextWindow: 1000 })).toBe(250);
  });

  test("estimates structured values through the shared registry", () => {
    const payload = {
      messages: [{ role: "user", content: "Explain why this regression happened." }],
      tools: [{ name: "search", description: "Search the repo" }],
    };
    expect(
      estimateStructuredTokenCount(payload, {
        api: "openai-responses",
        modelId: "gpt-4o",
      }),
    ).toBeGreaterThan(0);
  });

  test("estimates provider payload text without counting media bytes and protocol labels", () => {
    const estimate = estimateProviderPayloadTextTokens(
      {
        model: "gpt-5.4",
        messages: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Use the previous command result." },
              { type: "input_image", image_url: "data:image/png;base64,AAAA" },
            ],
          },
          {
            role: "tool",
            content: "important tool result ".repeat(64),
          },
        ],
      },
      {
        provider: "openai",
        api: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(
      estimateStructuredTokenCount("important tool result ".repeat(64), {
        api: "openai-responses",
        modelId: "gpt-5.4",
      }) + 20,
    );
  });

  test("normalizes provider cache posture without gateway policy", () => {
    expect(
      resolveCachePosture({
        status: "warm",
        bucketKey: "openai:gpt-5.4:bucket",
        stablePrefixHash: "stable-prefix-digest",
        dynamicTailHash: "dynamic-tail-digest",
        cacheReadTokens: 1200,
        cacheWriteTokens: 0,
      }),
    ).toEqual({
      status: "warm",
      bucketKey: "openai:gpt-5.4:bucket",
      stablePrefixHash: "stable-prefix-digest",
      dynamicTailHash: "dynamic-tail-digest",
      cacheReadTokens: 1200,
      cacheWriteTokens: 0,
      supported: true,
      reason: null,
    });

    expect(
      resolveCachePosture({
        status: "WARM",
        cacheReadTokens: 1.9,
        cacheWriteTokens: -4,
      }),
    ).toMatchObject({
      status: "warm",
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      supported: true,
    });

    expect(resolveCachePosture(undefined)).toEqual({
      status: "unknown",
      bucketKey: null,
      stablePrefixHash: null,
      dynamicTailHash: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      supported: false,
      reason: "missing_observation",
    });
  });
});
