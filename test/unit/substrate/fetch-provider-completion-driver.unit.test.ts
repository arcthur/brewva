import { afterEach, describe, expect, test } from "bun:test";
import {
  createFetchProviderCompletionDriver,
  type BrewvaProviderCompletionDriver,
  type BrewvaRegisteredModel,
  UnsupportedBrewvaProviderApiError,
} from "@brewva/brewva-substrate";

function createModel(overrides: Partial<BrewvaRegisteredModel> = {}): BrewvaRegisteredModel {
  return {
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-completions",
    baseUrl: "https://api.openai.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

function normalizeRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function parseJsonRequestBody(body: RequestInit["body"]): unknown {
  if (typeof body !== "string") {
    throw new Error("expected request body to be a string");
  }
  return JSON.parse(body);
}

describe("fetch provider completion driver", () => {
  afterEach(() => {
    // Reset any mutated fetch implementation between tests.
    globalThis.fetch = fetch;
  });

  test("completes OpenAI chat-completions requests without Pi runtime", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const driver: BrewvaProviderCompletionDriver = createFetchProviderCompletionDriver({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            model: "gpt-5.4",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: '{"ordered_ids":["b","a"]}',
                },
              },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    const response = await driver.complete({
      model: createModel(),
      systemPrompt: "Return JSON only.",
      userText: "Rank A and B.",
      auth: {
        apiKey: "OPENAI_KEY",
        headers: {
          "x-provider": "brewva",
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(normalizeRequestUrl(calls[0]!.input)).toBe(
      "https://api.openai.example.com/v1/chat/completions",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: "Bearer OPENAI_KEY",
      "content-type": "application/json",
      "x-provider": "brewva",
    });
    expect(parseJsonRequestBody(calls[0]!.init?.body)).toEqual({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Return JSON only." },
        { role: "user", content: "Rank A and B." },
      ],
      temperature: 0,
      max_completion_tokens: 1024,
    });
    expect(response).toEqual({
      role: "assistant",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: expect.any(Number),
      usage: {
        input: 11,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
      },
      content: [{ type: "text", text: '{"ordered_ids":["b","a"]}' }],
    });
  });

  test("uses Anthropic headers and content shape without Pi ai helpers", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const driver = createFetchProviderCompletionDriver({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            id: "msg_1",
            model: "claude-sonnet-4-5",
            stop_reason: "end_turn",
            usage: {
              input_tokens: 9,
              output_tokens: 5,
            },
            content: [{ type: "text", text: '{"accept":false}' }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    const response = await driver.complete({
      model: createModel({
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.example.com/v1",
      }),
      systemPrompt: "Return JSON only.",
      userText: "Classify this.",
      auth: {
        apiKey: "sk-ant-test",
      },
    });

    expect(calls).toHaveLength(1);
    expect(normalizeRequestUrl(calls[0]!.input)).toBe(
      "https://api.anthropic.example.com/v1/messages",
    );
    expect(calls[0]?.init?.headers).toEqual({
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
    });
    expect(parseJsonRequestBody(calls[0]!.init?.body)).toEqual({
      model: "claude-sonnet-4-5",
      system: "Return JSON only.",
      messages: [{ role: "user", content: "Classify this." }],
      max_tokens: 1024,
    });
    expect(response).toEqual({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "end_turn",
      timestamp: expect.any(Number),
      usage: {
        input: 9,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 14,
      },
      content: [{ type: "text", text: '{"accept":false}' }],
    });
  });

  test("supports Google Generative AI requests without Pi ai helpers", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const driver = createFetchProviderCompletionDriver({
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [{ text: '{"winner":"alpha"}' }],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 6,
              totalTokenCount: 18,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    const response = await driver.complete({
      model: createModel({
        provider: "google",
        id: "gemini-2.5-pro",
        name: "Gemini",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
      systemPrompt: "Return JSON only.",
      userText: "Rank these candidates.",
      auth: {
        apiKey: "GOOGLE_KEY",
        headers: {
          "x-provider": "brewva",
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(normalizeRequestUrl(calls[0]!.input)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
    );
    expect(calls[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-goog-api-key": "GOOGLE_KEY",
      "x-provider": "brewva",
    });
    expect(parseJsonRequestBody(calls[0]!.init?.body)).toEqual({
      systemInstruction: {
        parts: [{ text: "Return JSON only." }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: "Rank these candidates." }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1024,
      },
    });
    expect(response).toEqual({
      role: "assistant",
      provider: "google",
      model: "gemini-2.5-pro",
      stopReason: "stop",
      timestamp: expect.any(Number),
      usage: {
        input: 12,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
      },
      content: [{ type: "text", text: '{"winner":"alpha"}' }],
    });
  });

  test("throws a typed unsupported-api error for provider APIs that Brewva does not own yet", async () => {
    const driver = createFetchProviderCompletionDriver();

    try {
      await driver.complete({
        model: createModel({
          provider: "google",
          id: "gemini-cli",
          name: "Gemini CLI",
          api: "google-gemini-cli",
          baseUrl: "https://example.invalid",
        }),
        systemPrompt: "Return JSON only.",
        userText: "Rank these candidates.",
        auth: {},
      });
      throw new Error("expected unsupported provider api to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedBrewvaProviderApiError);
    }
  });
});
