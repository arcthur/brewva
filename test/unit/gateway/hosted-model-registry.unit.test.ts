import { describe, expect, test } from "bun:test";
import { HostedAuthStore } from "../../../packages/brewva-gateway/src/host/hosted-auth-store.js";
import { HostedModelRegistry } from "../../../packages/brewva-gateway/src/host/hosted-model-registry.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

const TEST_ENV_KEY = "BREWVA_HOSTED_MODEL_REGISTRY_TEST_KEY";

describe("hosted model registry", () => {
  test("resolves provider config values with Pi-aligned env-or-literal semantics", async () => {
    const restoreEnv = patchProcessEnv({ [TEST_ENV_KEY]: "resolved-token" });
    try {
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);

      registry.registerProvider("demo", {
        baseUrl: "https://demo.example.com/v1",
        api: "openai-completions",
        apiKey: TEST_ENV_KEY,
        authHeader: true,
        headers: {
          "x-provider-token": TEST_ENV_KEY,
        },
        models: [
          {
            id: "alpha",
            name: "Alpha",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
      });

      const model = registry.find("demo", "alpha");
      expect(model).toBeDefined();

      const auth = await registry.getApiKeyAndHeaders(model!);
      expect(auth).toEqual({
        ok: true,
        apiKey: "resolved-token",
        headers: {
          "x-provider-token": "resolved-token",
          Authorization: "Bearer resolved-token",
        },
      });
    } finally {
      restoreEnv();
    }
  });

  test("resolves auth-store api_key entries with Pi-aligned env-or-literal semantics", async () => {
    const restoreEnv = patchProcessEnv({ [TEST_ENV_KEY]: "stored-token" });
    try {
      const authStore = HostedAuthStore.inMemory({
        demo: {
          type: "api_key",
          key: TEST_ENV_KEY,
        },
      });

      const apiKey = await authStore.getApiKey("demo");
      expect(apiKey).toBe("stored-token");
    } finally {
      restoreEnv();
    }
  });
});
