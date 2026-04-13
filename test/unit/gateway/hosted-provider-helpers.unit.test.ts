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
      getHostedEnvApiKey(
        "google-vertex",
        {
          GOOGLE_CLOUD_PROJECT: "demo-project",
          GOOGLE_CLOUD_LOCATION: "us-central1",
        },
        {
          hasVertexAdcCredentials: () => true,
        },
      ),
    ).toBe("<authenticated>");

    expect(
      getHostedEnvApiKey("amazon-bedrock", {
        AWS_PROFILE: "default",
      }),
    ).toBe("<authenticated>");

    expect(
      getHostedEnvApiKey("openai", {
        OPENAI_API_KEY: "openai-key",
      }),
    ).toBe("openai-key");
  });

  test("reports xhigh support for the same model families as Pi", () => {
    expect(supportsHostedExtendedThinkingModel({ id: "gpt-5.4" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "claude-opus-4-6" })).toBe(true);
    expect(supportsHostedExtendedThinkingModel({ id: "claude-3-5-sonnet" })).toBe(false);
  });

  test("exposes built-in provider and model snapshots", () => {
    const providers = getHostedBuiltInProviders();
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");

    const openaiModels = getHostedBuiltInModels("openai");
    expect(openaiModels.some((model) => model.id === "gpt-5.4")).toBe(true);
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
