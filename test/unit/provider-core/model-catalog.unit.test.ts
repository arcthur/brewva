import { describe, expect, test } from "bun:test";
import { getModel, getModels } from "@brewva/brewva-provider-core";

describe("provider core model catalog", () => {
  test("exposes only the curated Google Gemini CLI catalog", () => {
    const retiredModelIds = [
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b",
      "gemini-1.5-pro",
      "gemini-2.5-flash-lite-preview-06-17",
      "gemini-2.5-flash-lite-preview-09-2025",
      "gemini-2.5-flash-preview-04-17",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-flash-preview-09-2025",
      "gemini-2.5-pro-preview-05-06",
      "gemini-2.5-pro-preview-06-05",
      "gemini-live-2.5-flash",
      "gemini-live-2.5-flash-preview-native-audio",
      "gemma-4-26b-it",
    ];

    const googleModelIds = getModels("google")
      .map((model) => model.id)
      .toSorted();

    for (const modelId of retiredModelIds) {
      expect(googleModelIds).not.toContain(modelId);
    }
    expect(googleModelIds).toEqual([
      "gemini-2.0-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
    ]);
  });

  test("uses clean Google model names after the provider migration", () => {
    const googleModelNames = getModels("google").map((model) => model.name);

    expect(googleModelNames).toContain("Gemini 2.5 Pro");
    expect(googleModelNames.some((name) => name.includes("Cloud Code Assist"))).toBe(false);
  });

  test("exposes documented Kimi Code and Moonshot platform model routes", () => {
    const kimiCodeModels = getModels("kimi-coding").map((model) => model.id);
    expect(kimiCodeModels).toEqual(["kimi-for-coding"]);

    const moonshotCnModels = getModels("moonshot-cn").map((model) => model.id);
    const moonshotAiModels = getModels("moonshot-ai").map((model) => model.id);
    expect(moonshotCnModels).toEqual(["kimi-k2.6", "kimi-k2.5"]);
    expect(moonshotAiModels).toEqual(moonshotCnModels);
  });

  test("exposes the current official OpenAI GPT family defaults", () => {
    const openaiModels = getModels("openai");
    const openaiModelIds = openaiModels.map((model) => model.id);

    expect(openaiModelIds).toContain("gpt-5.5");
    expect(openaiModelIds).toContain("gpt-5.5-pro");
    expect(openaiModelIds).toContain("gpt-5.4");
    expect(openaiModelIds).toContain("gpt-5.4-mini");
    expect(openaiModelIds).toContain("gpt-5.4-nano");

    const flagship = getModel("openai", "gpt-5.5");
    expect(flagship).toMatchObject({
      api: "openai-responses",
      provider: "openai",
      reasoning: true,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 5,
        output: 30,
        cacheRead: 0.5,
        cacheWrite: 0,
      },
    });
  });

  test("exposes only the official direct DeepSeek v4 models", () => {
    const deepseekModels = getModels("deepseek");
    const deepseekModelIds = deepseekModels.map((model) => model.id).toSorted();

    expect(deepseekModelIds).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(deepseekModelIds).not.toContain("deepseek-chat");
    expect(deepseekModelIds).not.toContain("deepseek-reasoner");

    const flash = getModel("deepseek", "deepseek-v4-flash");
    expect(flash).toMatchObject({
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      reasoning: true,
      input: ["text"],
      cost: {
        input: 0.14,
        output: 0.28,
        cacheRead: 0.0028,
        cacheWrite: 0,
      },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: expect.objectContaining({
        maxTokensField: "max_tokens",
        thinkingFormat: "deepseek",
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
      }),
    });

    const pro = getModel("deepseek", "deepseek-v4-pro");
    expect(pro.cost).toEqual({
      input: 1.74,
      output: 3.48,
      cacheRead: 0.0145,
      cacheWrite: 0,
    });
  });
});
