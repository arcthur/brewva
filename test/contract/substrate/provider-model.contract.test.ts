import { describe, expect, test } from "bun:test";
import { createInMemoryModelCatalog, type BrewvaRegisteredModel } from "@brewva/brewva-substrate";

describe("substrate provider model contract", () => {
  test("supports Pi-host-compatible model descriptors without importing Pi types", () => {
    const model: BrewvaRegisteredModel = {
      provider: "openai",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 200_000,
      maxTokens: 16_384,
      compat: {
        supportsStore: true,
        maxTokensField: "max_completion_tokens",
      },
      headers: {
        "x-test": "1",
      },
    };

    const catalog = createInMemoryModelCatalog({
      models: [model],
      auth: {
        async getApiKey() {
          return "test-key";
        },
        hasAuth() {
          return true;
        },
        isUsingOAuth() {
          return false;
        },
      },
    });

    expect(catalog.getAll()[0]?.compat).toEqual({
      supportsStore: true,
      maxTokensField: "max_completion_tokens",
    });
    expect(catalog.hasConfiguredAuth(model)).toBe(true);
  });
});
