import { describe, expect, test } from "bun:test";
import { getModel, getModels } from "@brewva/brewva-provider-core/catalog";

describe("provider core model catalog", () => {
  test("exposes Google models only through the direct GenAI provider", () => {
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

    expect(getModels("google")).toEqual([]);

    const googleModelIds = getModels("google-genai")
      .map((model) => model.id)
      .toSorted();

    for (const modelId of retiredModelIds) {
      expect(googleModelIds).not.toContain(modelId);
    }
    expect(googleModelIds).toContain("gemini-2.5-pro");
    expect(googleModelIds).toContain("gemini-3-pro-preview");
  });

  test("uses clean Google model names after the provider migration", () => {
    const googleModelNames = getModels("google-genai").map((model) => model.name);

    expect(googleModelNames).toContain("Gemini 2.5 Pro");
  });

  test("exposes documented Kimi Code route and generated Moonshot platform catalogs", () => {
    const kimiCodeModels = getModels("kimi-coding").map((model) => model.id);
    expect(kimiCodeModels).toEqual(["kimi-for-coding"]);

    const moonshotCnModels = getModels("moonshot-cn").map((model) => model.id);
    const moonshotAiModels = getModels("moonshot-ai").map((model) => model.id);
    expect(moonshotAiModels).toEqual(moonshotCnModels);
    expect(moonshotCnModels).toContain("kimi-k2.6");
    expect(moonshotCnModels).toContain("kimi-k2.5");
    expect(moonshotCnModels).toContain("kimi-k2-thinking");
    expect(moonshotCnModels).not.toContain("k2p6");
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

  test("derives OpenAI Codex OAuth models from the OpenAI catalog", () => {
    const codexModels = getModels("openai-codex");
    const codexModelIds = codexModels.map((model) => model.id);

    expect(codexModelIds).toContain("gpt-5.5");
    expect(codexModelIds).toContain("gpt-5.4");
    expect(codexModelIds).toContain("gpt-5.4-mini");
    // Probed against the ChatGPT backend (2026-07-03): -pro/-codex variants and
    // sub-mainline ids are rejected on the Codex channel and must not be offered.
    expect(codexModelIds).not.toContain("gpt-5.5-pro");
    expect(codexModelIds).not.toContain("gpt-5.5-codex");
    expect(codexModelIds).not.toContain("gpt-5.1-codex-max");
    expect(codexModelIds).not.toContain("gpt-5.4-nano");

    const flagship = getModel("openai-codex", "gpt-5.5");
    expect(flagship).toMatchObject({
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
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
