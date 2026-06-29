import { describe, expect, test } from "bun:test";
import type { AssistantMessageEvent, Model } from "@brewva/brewva-provider-core/contracts";
import { streamOpenAICodexResponses } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses/adapter.js";
import { collectProviderEvents } from "../../helpers/effect-stream.js";

const CODEX_MODEL: Model<"openai-codex-responses"> = {
  id: "gpt-5.4-codex",
  name: "GPT-5.4 Codex",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function createFakeCodexToken(): string {
  const payload = btoa(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } }),
  );
  return `header.${payload}.signature`;
}

function findErrorEvent(
  events: readonly AssistantMessageEvent[],
): (AssistantMessageEvent & { retryable?: boolean }) | undefined {
  return events.find((event) => event.type === "error");
}

describe("openai codex retryable classification", () => {
  test("flags a model-not-entitled rejection as non-retryable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          detail:
            "The 'gpt-5.1-codex-max' model is not supported when using Codex with a ChatGPT account.",
        }),
        { status: 400, statusText: "Bad Request" },
      )) as unknown as typeof fetch;
    try {
      const events = await collectProviderEvents(
        streamOpenAICodexResponses(
          CODEX_MODEL,
          { messages: [] },
          { apiKey: createFakeCodexToken(), transport: "sse" },
        ),
      );
      const errorEvent = findErrorEvent(events);
      expect(errorEvent?.type).toBe("error");
      expect(errorEvent?.retryable).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("flags a transient upstream failure as retryable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("service unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      })) as unknown as typeof fetch;
    try {
      const events = await collectProviderEvents(
        streamOpenAICodexResponses(
          CODEX_MODEL,
          { messages: [] },
          { apiKey: createFakeCodexToken(), transport: "sse", maxRetries: 0, maxRetryDelayMs: 1 },
        ),
      );
      const errorEvent = findErrorEvent(events);
      expect(errorEvent?.type).toBe("error");
      expect(errorEvent?.retryable).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
