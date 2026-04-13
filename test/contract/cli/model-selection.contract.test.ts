import { describe, expect, test } from "bun:test";
import { createInMemoryModelCatalog } from "@brewva/brewva-substrate";
import { resolveBrewvaModelSelection } from "@brewva/brewva-tools";

function createRegistry() {
  const registry = createInMemoryModelCatalog({
    models: [],
    auth: {
      async getApiKey() {
        return undefined;
      },
      hasAuth() {
        return true;
      },
      isUsingOAuth() {
        return false;
      },
    },
  });

  registry.registerProvider("demo", {
    baseUrl: "https://demo.example.com/v1",
    apiKey: "DEMO_API_KEY",
    models: [
      {
        id: "alpha",
        name: "Alpha",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha-20260101",
        name: "Alpha Snapshot",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha:exacto",
        name: "Alpha Exacto",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "beta-mini",
        name: "Beta Mini",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "alpha-mini",
        name: "Alpha Mini",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });

  registry.registerProvider("proxy", {
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "PROXY_API_KEY",
    models: [
      {
        id: "demo/alt",
        name: "Proxy Alt",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });

  return registry;
}

describe("resolveBrewvaModelSelection", () => {
  test("supports thinking shorthand for provider-scoped model ids with colons", () => {
    const resolved = resolveBrewvaModelSelection("demo/alpha:exacto:high", createRegistry());

    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha:exacto");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("supports exact unique model ids without a provider prefix", () => {
    const resolved = resolveBrewvaModelSelection("alpha", createRegistry());

    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha");
    expect(resolved.thinkingLevel).toBeUndefined();
  });

  test("falls back to full model ids when provider inference would be wrong", () => {
    const resolved = resolveBrewvaModelSelection("demo/alt:high", createRegistry());

    expect(resolved.model?.provider).toBe("proxy");
    expect(resolved.model?.id).toBe("demo/alt");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("throws for unknown or invalid model overrides", () => {
    expect(() => resolveBrewvaModelSelection("demo/missing", createRegistry())).toThrow(
      'Model "demo/missing" was not found in the configured Brewva model registry.',
    );
    expect(() => resolveBrewvaModelSelection("demo/alpha:nope", createRegistry())).toThrow(
      'Model "demo/alpha:nope" was not found in the configured Brewva model registry.',
    );
  });

  test("rejects display-name and fuzzy model lookups now that exact ids are canonical", () => {
    expect(() => resolveBrewvaModelSelection("Alpha", createRegistry())).toThrow(
      'Model "Alpha" was not found in the configured Brewva model registry.',
    );
    expect(() => resolveBrewvaModelSelection("mini", createRegistry())).toThrow(
      'Model "mini" was not found in the configured Brewva model registry.',
    );
  });
});
