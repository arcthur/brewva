import { describe, expect, test } from "bun:test";
import { buildProviderPayloadMetadata } from "../../../packages/brewva-provider-core/src/providers/_shared/payload-metadata.js";

describe("provider payload metadata", () => {
  test("derives cache capability from the cache capability seam when render is absent", () => {
    const metadata = buildProviderPayloadMetadata(
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        transport: "websocket",
      },
      { prompt: "hello" },
    );

    expect(metadata.cacheCapability).toMatchObject({
      strategies: ["promptCacheKey"],
      longRetention: "24h",
      cacheCounters: "readOnly",
    });
    expect(metadata.providerFallback).toEqual({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });
});
