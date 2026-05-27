import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Model } from "../../../packages/brewva-provider-core/src/contracts/index.js";
import type { GoogleGenAIClient } from "../../../packages/brewva-provider-core/src/providers/google-genai/contract.js";
import {
  streamGoogleGenAI,
  streamSimpleGoogleGenAI,
} from "../../../packages/brewva-provider-core/src/providers/google-genai/index.js";
import { collectProviderEvents } from "../../helpers/effect-stream.js";

function createGoogleGenAIModel(
  overrides: Partial<Model<"google-genai">> = {},
): Model<"google-genai"> {
  const model: Model<"google-genai"> = {
    api: "google-genai",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google-genai",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    cost: { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 4.5 },
  };
  return { ...model, ...overrides };
}

function createClient(chunks: unknown[]): GoogleGenAIClient {
  return {
    models: {
      async *generateContentStream() {
        for (const chunk of chunks) {
          yield chunk as never;
        }
      },
    },
  };
}

function getThinkingConfig(params: unknown): Record<string, unknown> | undefined {
  return (params as { config?: { thinkingConfig?: Record<string, unknown> } }).config
    ?.thinkingConfig;
}

describe("google genai stream", () => {
  test("streams text, thinking, tool calls, response id, and usage from SDK chunks", async () => {
    const stream = streamGoogleGenAI(
      createGoogleGenAIModel(),
      {
        messages: [],
        tools: [
          {
            name: "lookup",
            description: "Lookup a value",
            parameters: Type.Object({ query: Type.String() }),
          },
        ],
      },
      {
        apiKey: "google-api-key",
        client: createClient([
          {
            responseId: "resp_google_genai_1",
            candidates: [
              {
                content: {
                  parts: [{ text: "Plan", thought: true, thoughtSignature: "sig_1" }],
                },
              },
            ],
          },
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Answer" },
                    {
                      functionCall: {
                        id: "call_1",
                        name: "lookup",
                        args: { query: "brewva" },
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              cachedContentTokenCount: 4,
              candidatesTokenCount: 2,
              thoughtsTokenCount: 1,
              totalTokenCount: 13,
            },
          },
        ]),
      },
    );

    const events = await collectProviderEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.responseId).toBe("resp_google_genai_1");
      expect(done.message.stopReason).toBe("toolUse");
      expect(done.message.usage.input).toBe(6);
      expect(done.message.usage.output).toBe(3);
      expect(done.message.usage.cacheRead).toBe(4);
      expect(done.message.usage.totalTokens).toBe(13);
      expect(done.message.content).toEqual([
        {
          type: "thinking",
          thinking: "Plan",
          thinkingSignature: "sig_1",
        },
        {
          type: "text",
          text: "Answer",
        },
        {
          type: "toolCall",
          id: "call_1",
          name: "lookup",
          arguments: { query: "brewva" },
        },
      ]);
    }
  });

  test("passes converted contents, tools, cached content, and generation config to the SDK", async () => {
    let observedParams: unknown;
    let observedCacheRender: unknown;
    const client: GoogleGenAIClient = {
      models: {
        async *generateContentStream(params: unknown) {
          observedParams = params;
          yield {
            candidates: [
              {
                content: { parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          } as never;
        },
      },
    };

    await collectProviderEvents(
      streamGoogleGenAI(
        createGoogleGenAIModel(),
        {
          systemPrompt: "System prompt",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Hello" }],
              timestamp: 1,
            },
          ],
          tools: [
            {
              name: "lookup",
              description: "Lookup a value",
              parameters: Type.Object({ query: Type.String() }),
            },
          ],
        },
        {
          apiKey: "google-api-key",
          client,
          maxTokens: 123,
          temperature: 0.25,
          toolChoice: "any",
          thinking: { enabled: true, budgetTokens: 512 },
          cachePolicy: {
            retention: "long",
            writeMode: "readWrite",
            scope: "session",
            reason: "config",
          },
          cacheControl: {
            cachedContent: {
              name: "cachedContents/brewva-google-genai",
              ttlSeconds: 7_200,
            },
          },
          onCacheRender: (cacheRender) => {
            observedCacheRender = cacheRender;
          },
        },
      ),
    );

    expect(observedParams).toMatchObject({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      config: {
        systemInstruction: { parts: [{ text: "System prompt" }] },
        maxOutputTokens: 123,
        temperature: 0.25,
        cachedContent: "cachedContents/brewva-google-genai",
        thinkingConfig: { thinkingBudget: 512 },
        tools: [
          {
            functionDeclarations: [
              {
                name: "lookup",
                parametersJsonSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" },
                  },
                },
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
          },
        },
      },
    });
    const config = (observedParams as { config?: { abortSignal?: AbortSignal } }).config;
    expect(config?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(observedCacheRender).toMatchObject({
      status: "rendered",
      reason: "rendered_google_genai_cached_content",
      cachedContentName: "cachedContents/brewva-google-genai",
      cachedContentTtlSeconds: 7_200,
    });
  });

  test("emits cache render metadata before invoking the SDK", async () => {
    let observedCacheRender: unknown;
    let observedPayloadMetadata: unknown;

    await collectProviderEvents(
      streamGoogleGenAI(
        createGoogleGenAIModel(),
        { messages: [] },
        {
          apiKey: "google-api-key",
          client: createClient([
            {
              candidates: [
                {
                  content: { parts: [{ text: "ok" }] },
                  finishReason: "STOP",
                },
              ],
            },
          ]),
          sessionId: "session-google-genai-short",
          cachePolicy: {
            retention: "short",
            writeMode: "readWrite",
            scope: "session",
            reason: "config",
          },
          onCacheRender: (cacheRender) => {
            observedCacheRender = cacheRender;
          },
          onPayload: (_payload, _model, metadata) => {
            observedPayloadMetadata = metadata;
          },
        },
      ),
    );

    expect(observedCacheRender).toMatchObject({
      status: "rendered",
      reason: "rendered_google_genai_implicit_prefix_cache",
      renderedRetention: "short",
      bucketKey:
        "google-genai|session=session-google-genai-short|retention=short|writeMode=readWrite",
    });
    expect(observedPayloadMetadata).toMatchObject({
      cacheRender: observedCacheRender,
      cacheCapability: {
        strategies: ["implicitPrefix", "explicitCachedContent"],
      },
    });
  });

  test("simple stream maps Gemini 2.5 reasoning to thinking budget", async () => {
    let observedParams: unknown;
    const client: GoogleGenAIClient = {
      models: {
        async *generateContentStream(params: unknown) {
          observedParams = params;
          yield {
            candidates: [
              {
                content: { parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          } as never;
        },
      },
    };

    const options: Parameters<typeof streamSimpleGoogleGenAI>[2] & {
      client: GoogleGenAIClient;
    } = {
      apiKey: "google-api-key",
      client,
      maxTokens: 1_000,
      reasoning: "medium",
      thinkingBudgets: { medium: 128 },
    };

    await collectProviderEvents(
      streamSimpleGoogleGenAI(createGoogleGenAIModel(), { messages: [] }, options),
    );

    expect(getThinkingConfig(observedParams)).toEqual({
      thinkingBudget: 128,
      includeThoughts: true,
    });
  });

  test("preserves explicit zero thinking budget", async () => {
    let observedParams: unknown;
    const client: GoogleGenAIClient = {
      models: {
        async *generateContentStream(params: unknown) {
          observedParams = params;
          yield {
            candidates: [
              {
                content: { parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          } as never;
        },
      },
    };

    await collectProviderEvents(
      streamGoogleGenAI(
        createGoogleGenAIModel(),
        { messages: [] },
        {
          apiKey: "google-api-key",
          client,
          thinking: { enabled: true, budgetTokens: 0 },
        },
      ),
    );

    expect(getThinkingConfig(observedParams)).toMatchObject({
      thinkingBudget: 0,
      includeThoughts: true,
    });
  });

  test("simple stream maps Gemini 3 reasoning to thinking level", async () => {
    let observedParams: unknown;
    const client: GoogleGenAIClient = {
      models: {
        async *generateContentStream(params: unknown) {
          observedParams = params;
          yield {
            candidates: [
              {
                content: { parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
          } as never;
        },
      },
    };

    const options: Parameters<typeof streamSimpleGoogleGenAI>[2] & {
      client: GoogleGenAIClient;
    } = {
      apiKey: "google-api-key",
      client,
      maxTokens: 1_000,
      reasoning: "high",
    };

    await collectProviderEvents(
      streamSimpleGoogleGenAI(
        createGoogleGenAIModel({
          id: "gemini-3-pro-preview",
          name: "Gemini 3 Pro Preview",
        }),
        { messages: [] },
        options,
      ),
    );

    expect(getThinkingConfig(observedParams)).toEqual({
      thinkingLevel: "HIGH",
      includeThoughts: true,
    });
  });
});
