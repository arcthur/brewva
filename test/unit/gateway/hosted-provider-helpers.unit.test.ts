import { describe, expect, test } from "bun:test";
import { getModels, getProviders } from "@brewva/brewva-provider-core";
import {
  getHostedBuiltInModels,
  getHostedBuiltInProviders,
  getHostedEnvApiKey,
  supportsHostedExtendedThinkingModel,
} from "../../../packages/brewva-gateway/src/host/hosted-provider-helpers.js";

describe("hosted provider helpers", () => {
  test("resolves provider auth from env using Pi-aligned semantics", () => {
    expect(
      getHostedEnvApiKey("anthropic", {
        ANTHROPIC_API_KEY: "anthropic-key",
        ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth",
      }),
    ).toBe("anthropic-oauth");

    expect(
      getHostedEnvApiKey("openai", {
        OPENAI_API_KEY: "openai-key",
      }),
    ).toBe("openai-key");

    expect(
      getHostedEnvApiKey("deepseek", {
        DEEPSEEK_API_KEY: "deepseek-key",
      }),
    ).toBe("deepseek-key");

    expect(
      getHostedEnvApiKey("moonshot-cn", {
        MOONSHOT_CN_API_KEY: "moonshot-cn-key",
      }),
    ).toBe("moonshot-cn-key");

    expect(
      getHostedEnvApiKey("moonshot-ai", {
        MOONSHOT_AI_API_KEY: "moonshot-ai-key",
      }),
    ).toBe("moonshot-ai-key");

    expect(
      getHostedEnvApiKey("moonshot-cn", {
        MOONSHOT_API_KEY: "moonshot-generic-key",
      }),
    ).toBeUndefined();

    expect(
      getHostedEnvApiKey("moonshot-ai", {
        MOONSHOT_API_KEY: "moonshot-generic-key",
      }),
    ).toBeUndefined();
  });

  test("reports xhigh support for the same model families as Pi", () => {
    expect(supportsHostedExtendedThinkingModel({ id: "gpt-5.5" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "gpt-5.4" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "deepseek-v4-flash" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "deepseek-v4-pro" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "claude-opus-4-6" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "claude-3-5-sonnet" })).toBe(false);
  });

  test("exposes built-in provider and model snapshots", () => {
    const providers = getHostedBuiltInProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");

    const openaiModels = getHostedBuiltInModels("openai");
    expect(openaiModels.some((model) => model.id === "gpt-5.5")).toBe(true);
  });

  test("mirrors provider-core built-in provider and model catalog", () => {
    const hostedProviders = [...getHostedBuiltInProviders()].toSorted();
    const providerCoreProviders = [...getProviders()].toSorted();

    expect(hostedProviders).toEqual(providerCoreProviders);

    for (const provider of providerCoreProviders) {
      const hostedModelIds = getHostedBuiltInModels(provider)
        .map((model) => model.id)
        .toSorted();
      const providerCoreModelIds = getModels(provider)
        .map((model) => model.id)
        .toSorted();

      expect(hostedModelIds).toEqual(providerCoreModelIds);
    }
  });
});
