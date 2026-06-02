import { describe, expect, test } from "bun:test";
import {
  MAX_COMPACTION_PROMPT_TOO_LARGE_ATTEMPTS,
  generateCompactionSummaryWithPromptTooLargeRetry,
} from "../../../packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.js";
import type { BrewvaCompactionSummaryGenerationInput } from "../../../packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.js";

const baseInput = {
  sessionId: "session-1",
  cwd: "/workspace",
  model: {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
  messages: Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: index < 4 ? "older ".repeat(200) : `recent-${index}`,
  })),
  systemPrompt: "system",
} satisfies BrewvaCompactionSummaryGenerationInput;

function estimateMessagesTokens(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const serialized = JSON.stringify(message) ?? "";
    total += Math.max(1, Math.ceil(serialized.length / 4));
  }
  return total;
}

describe("compaction summary prompt-too-large retry", () => {
  test("retries prompt-too-large failures with a token-weighted reduced transcript", async () => {
    const observed = new Map<number, readonly unknown[]>();
    const result = await generateCompactionSummaryWithPromptTooLargeRetry({
      input: baseInput,
      generate: async (input) => {
        observed.set(observed.size + 1, input.messages);
        if (observed.size < 3) {
          throw new Error("context_length_exceeded");
        }
        return {
          summary: "1. Current Objective\n- Continue.\n2. Current State\n- Ready.",
          strategy: "llm_primary_compaction",
        };
      },
    });

    expect(result.summary).toContain("Continue");
    const initialMessages = observed.get(1)!;
    const firstRetryMessages = observed.get(2)!;
    const secondRetryMessages = observed.get(3)!;
    expect(firstRetryMessages.at(-1)).toEqual(initialMessages.at(-1));
    expect(estimateMessagesTokens(firstRetryMessages)).toBeLessThan(
      estimateMessagesTokens(initialMessages) * 0.4,
    );
    expect(estimateMessagesTokens(secondRetryMessages)).toBeLessThan(
      estimateMessagesTokens(firstRetryMessages),
    );
  });

  test("stops after the bounded retry limit", async () => {
    let attempts = 0;
    let thrown: unknown;

    try {
      await generateCompactionSummaryWithPromptTooLargeRetry({
        input: baseInput,
        generate: async () => {
          attempts += 1;
          throw new Error("prompt too large for compaction request");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("prompt too large");
    expect(attempts).toBe(MAX_COMPACTION_PROMPT_TOO_LARGE_ATTEMPTS);
  });
});
