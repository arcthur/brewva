import { describe, expect, test } from "bun:test";
import { resolveBrewvaModelSelection } from "@brewva/brewva-gateway/policy/model-routing";
import { createInMemoryModelCatalog } from "@brewva/brewva-substrate/provider";

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

  // An aggregator provider whose BARE ids collide with other providers: "demo/alpha"
  // equals demo-provider's fully-qualified name, and "beta-mini" equals demo's bare
  // id. This is the shape that made a real run go ambiguous
  // (deepseek/deepseek-v4-pro direct vs openrouter/deepseek/deepseek-v4-pro).
  registry.registerProvider("aggregator", {
    baseUrl: "https://aggregator.example.com/v1",
    apiKey: "AGGREGATOR_API_KEY",
    models: [
      {
        id: "demo/alpha",
        name: "Aggregated Alpha",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: "beta-mini",
        name: "Aggregated Beta Mini",
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
    expect(resolved.thinkingLevel).toBe(undefined);
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

  test("prefers a fully-qualified provider/id match over a bare-id collision (no false ambiguity)", () => {
    // "demo/alpha" is demo-provider's qualified name AND aggregator-provider's bare
    // id. The qualified match wins outright instead of throwing ambiguous — the
    // real-run deepseek/deepseek-v4-pro (direct) vs openrouter/deepseek/… case.
    const resolved = resolveBrewvaModelSelection("demo/alpha", createRegistry());
    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha");
  });

  test("with a thinking suffix, still prefers the qualified match (the deepseek-v4-pro:xhigh shape)", () => {
    // Exactly the up5 failure input shape: a fully-qualified name plus an effort suffix.
    const resolved = resolveBrewvaModelSelection("demo/alpha:high", createRegistry());
    expect(resolved.model?.provider).toBe("demo");
    expect(resolved.model?.id).toBe("alpha");
    expect(resolved.thinkingLevel).toBe("high");
  });

  test("still rejects a genuine cross-provider bare-id collision as ambiguous", () => {
    // "beta-mini" is a bare id on BOTH demo and aggregator with no qualifying
    // prefix — a real ambiguity that must still throw (the fix narrows FALSE
    // ambiguity, it does not swallow real ones).
    expect(() => resolveBrewvaModelSelection("beta-mini", createRegistry())).toThrow(/ambiguous/);
  });
});
