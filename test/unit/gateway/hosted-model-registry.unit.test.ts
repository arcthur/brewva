import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAuthStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.js";
import {
  createHostedModelServices,
  HostedModelRegistry,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-model-registry.js";
import { requireDefined } from "../../helpers/assertions.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

const TEST_ENV_KEY = "BREWVA_HOSTED_MODEL_REGISTRY_TEST_KEY";

describe("hosted model registry", () => {
  test("uses literal hosted provider config values without reading ambient env", async () => {
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

      const model = requireDefined(
        registry.find("demo", "alpha"),
        "Expected registered demo alpha model.",
      );

      const auth = await registry.getApiKeyAndHeaders(model);
      expect(auth).toEqual({
        ok: true,
        apiKey: TEST_ENV_KEY,
        headers: {
          "x-provider-token": TEST_ENV_KEY,
          Authorization: `Bearer ${TEST_ENV_KEY}`,
        },
      });
    } finally {
      restoreEnv();
    }
  });

  test("uses literal auth-store api_key values without reading ambient env", async () => {
    const restoreEnv = patchProcessEnv({ [TEST_ENV_KEY]: "stored-token" });
    try {
      const authStore = HostedAuthStore.inMemory({
        demo: {
          type: "api_key",
          key: TEST_ENV_KEY,
        },
      });

      const apiKey = await authStore.getApiKey("demo");
      expect(apiKey).toBe(TEST_ENV_KEY);
    } finally {
      restoreEnv();
    }
  });

  test("ignores ambient provider env until credentials are stored in Brewva", async () => {
    const restoreEnv = patchProcessEnv({ DEEPSEEK_API_KEY: "ambient-deepseek-key" });
    try {
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      const model = requireDefined(
        registry.find("deepseek", "deepseek-v4-flash"),
        "Expected built-in DeepSeek model.",
      );

      expect(authStore.hasAuth("deepseek")).toBe(false);
      expect(await authStore.getApiKey("deepseek")).toBe(undefined);
      expect(registry.hasConfiguredAuth(model)).toBe(false);
      const auth = await registry.getApiKeyAndHeaders(model);
      expect(auth).toEqual({
        ok: true,
        apiKey: undefined,
        headers: undefined,
      });
    } finally {
      restoreEnv();
    }
  });

  test("persists hosted auth credentials in the agent auth store", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "brewva-hosted-model-services-"));
    try {
      const first = createHostedModelServices(agentDir);
      first.authStore.set("openai-codex", {
        type: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
      });

      const raw = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as Record<
        string,
        { type?: string }
      >;
      expect(raw["openai-codex"]).toMatchObject({ type: "oauth" });

      const second = createHostedModelServices(agentDir);
      expect(second.authStore.get("openai-codex")).toMatchObject({
        type: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
      });
      expect(second.authStore.hasAuth("openai-codex")).toBe(true);

      second.authStore.remove("openai-codex");
      const third = createHostedModelServices(agentDir);
      expect(third.authStore.get("openai-codex")).toBe(undefined);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
