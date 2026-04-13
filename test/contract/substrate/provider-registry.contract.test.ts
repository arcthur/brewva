import { describe, expect, test } from "bun:test";
import { createInMemoryModelCatalog, type BrewvaRegisteredModel } from "@brewva/brewva-substrate";

function model(overrides: Partial<BrewvaRegisteredModel> = {}): BrewvaRegisteredModel {
  return {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
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

describe("substrate provider registry", () => {
  test("applies override-only provider registration and restores built-ins on unregister", async () => {
    const catalog = createInMemoryModelCatalog({
      models: [model()],
      auth: {
        async getApiKey(provider) {
          return provider === "anthropic" ? "stored-key" : undefined;
        },
      },
    });

    catalog.registerProvider("anthropic", {
      baseUrl: "http://localhost:8080/proxy",
      headers: {
        "x-proxy": "enabled",
      },
    });

    const active = catalog.find("anthropic", "claude-sonnet");
    expect(active?.baseUrl).toBe("http://localhost:8080/proxy");

    const auth = await catalog.getApiKeyAndHeaders(active!);
    expect(auth).toEqual({
      ok: true,
      apiKey: "stored-key",
      headers: {
        "x-proxy": "enabled",
      },
    });

    catalog.unregisterProvider("anthropic");

    expect(catalog.find("anthropic", "claude-sonnet")?.baseUrl).toBe("https://api.anthropic.com");
  });

  test("keeps override-only provider headers in request auth instead of mutating model descriptors", async () => {
    const catalog = createInMemoryModelCatalog({
      models: [model({ headers: { "x-built-in": "base" } })],
      auth: {
        async getApiKey(provider) {
          return provider === "anthropic" ? "stored-key" : undefined;
        },
        hasAuth(provider) {
          return provider === "anthropic";
        },
      },
    });

    catalog.registerProvider("anthropic", {
      baseUrl: "http://localhost:8080/proxy",
      headers: {
        "x-proxy": "enabled",
      },
    });

    const active = catalog.find("anthropic", "claude-sonnet");
    expect(active?.headers).toEqual({
      "x-built-in": "base",
    });

    const auth = await catalog.getApiKeyAndHeaders(active!);
    expect(auth).toEqual({
      ok: true,
      apiKey: "stored-key",
      headers: {
        "x-built-in": "base",
        "x-proxy": "enabled",
      },
    });
  });

  test("replaces provider models when dynamic registration provides an explicit model list", () => {
    const catalog = createInMemoryModelCatalog({
      models: [model(), model({ id: "claude-haiku", name: "Claude Haiku" })],
    });

    catalog.registerProvider("anthropic", {
      baseUrl: "http://localhost:9000",
      apiKey: "dynamic-key",
      models: [
        {
          id: "claude-custom",
          name: "Claude Custom",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 100_000,
          maxTokens: 8_000,
        },
      ],
    });

    expect(catalog.getAll().map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-custom",
    ]);
  });

  test("keeps dynamic model headers in request auth instead of mutating model descriptors", async () => {
    const catalog = createInMemoryModelCatalog({
      models: [model()],
      auth: {
        async getApiKey(provider) {
          return provider === "anthropic" ? "dynamic-key" : undefined;
        },
        hasAuth(provider) {
          return provider === "anthropic";
        },
      },
    });

    catalog.registerProvider("anthropic", {
      baseUrl: "http://localhost:9000",
      headers: {
        "x-provider": "provider",
      },
      models: [
        {
          id: "claude-custom",
          name: "Claude Custom",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 100_000,
          maxTokens: 8_000,
          headers: {
            "x-model": "model",
          },
        },
      ],
    });

    const active = catalog.find("anthropic", "claude-custom");
    expect(active?.headers).toBeUndefined();

    const auth = await catalog.getApiKeyAndHeaders(active!);
    expect(auth).toEqual({
      ok: true,
      apiKey: "dynamic-key",
      headers: {
        "x-provider": "provider",
        "x-model": "model",
      },
    });
  });
});
