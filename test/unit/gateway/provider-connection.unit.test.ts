import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureCredentialVaultModelAuth,
  createProviderConnectionPort,
} from "../../../packages/brewva-gateway/src/hosted/internal/provider/connection-port.js";
import type { ProviderAuthHandler } from "../../../packages/brewva-gateway/src/hosted/internal/provider/types.js";
import { HostedAuthStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-auth-store.js";
import { HostedModelRegistry } from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-model-registry.js";
import { requireDefined } from "../../helpers/assertions.js";
import { patchProcessEnv } from "../../helpers/global-state.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

const INTRINSIC_FETCH = globalThis.fetch;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function readJsonRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    return {};
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

async function blockTcpPortUntilCancel(port: number): Promise<Server | undefined> {
  const server = createServer((req, res) => {
    if (req.url === "/cancel") {
      res.writeHead(200);
      res.end("cancelled", () => {
        server.close();
      });
      return;
    }
    res.writeHead(409);
    res.end("busy");
  });
  return await new Promise<Server | undefined>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (error: unknown) => {
      cleanup();
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "EADDRINUSE"
      ) {
        resolve(undefined);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(() => {
  globalThis.fetch = INTRINSIC_FETCH;
});

function registerDemoProvider(registry: HostedModelRegistry): void {
  registry.registerProvider("demo", {
    baseUrl: "https://demo.example.com/v1",
    api: "openai-completions",
    authHeader: true,
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
}

function registerSingleModelProvider(
  registry: HostedModelRegistry,
  provider: string,
  model: string,
): void {
  registry.registerProvider(provider, {
    baseUrl: `https://${provider}.example.com/v1`,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: model,
        name: model,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    ],
  });
}

function registerGoogleGenAIProvider(registry: HostedModelRegistry): void {
  registry.registerProvider("google-genai", {
    baseUrl: "https://generativelanguage.googleapis.com",
    api: "google-genai",
    models: [
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 8_192,
      },
    ],
  });
}

describe("provider connection port", () => {
  test("stores API-key provider credentials in the runtime vault and makes models available", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerDemoProvider(registry);
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry });

      expect(registry.getAvailable().some((model) => model.provider === "demo")).toBe(false);

      await port.connectApiKey("demo", "demo-secret");

      expect(registry.getAvailable().some((model) => model.provider === "demo")).toBe(true);
      const model = requireDefined(
        registry.find("demo", "alpha"),
        "Expected connected demo alpha model.",
      );
      expect(await registry.getApiKeyAndHeaders(model)).toEqual({
        ok: true,
        apiKey: "demo-secret",
        headers: {
          Authorization: "Bearer demo-secret",
        },
      });
      expect((await port.listProviders()).find((provider) => provider.id === "demo")).toMatchObject(
        {
          connected: true,
          connectionSource: "vault",
          credentialRef: "vault://demo/apiKey",
        },
      );

      await port.disconnect("demo");
      expect(registry.getAvailable().some((candidate) => candidate.provider === "demo")).toBe(
        false,
      );
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("consolidates OpenAI and OpenAI Codex into one connect provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry });

      const providers = await port.listProviders();

      expect(providers.map((provider) => provider.id)).toContain("openai");
      expect(providers.map((provider) => provider.id)).not.toContain("openai-codex");
      expect(providers.find((provider) => provider.id === "openai")).toMatchObject({
        name: "OpenAI",
        group: "popular",
        modelProviders: ["openai", "openai-codex"],
        modelCount: 2,
        credentialRef: "vault://openai/apiKey",
      });
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("exposes direct Google GenAI through the Google connect provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerGoogleGenAIProvider(registry);
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      const providers = await port.listProviders();

      expect(providers.map((provider) => provider.id)).toContain("google");
      expect(providers.map((provider) => provider.id)).not.toContain("google-genai");
      expect(providers.find((provider) => provider.id === "google")).toMatchObject({
        name: "Google",
        group: "popular",
        description: "Gemini API key",
        modelProviders: ["google-genai"],
        modelCount: 1,
        credentialRef: "vault://google-genai/apiKey",
      });

      expect(port.listAuthMethods("google")).toEqual([
        expect.objectContaining({
          id: "google_genai_api_key",
          kind: "api_key",
          credentialProvider: "google-genai",
          modelProviderFilter: "google-genai",
          credentialRef: "vault://google-genai/apiKey",
        }),
      ]);

      await port.connectApiKey("google-genai", "google-genai-secret");
      expect(registry.getAvailable().some((model) => model.provider === "google-genai")).toBe(true);

      await port.disconnect("google");
      expect(registry.getAvailable().some((model) => model.provider === "google-genai")).toBe(
        false,
      );

      await port.connectApiKey("google", "google-public-secret");
      const model = requireDefined(
        registry.find("google-genai", "gemini-2.5-pro"),
        "Expected connected Google GenAI model.",
      );
      expect(await registry.getApiKeyAndHeaders(model)).toEqual({
        ok: true,
        apiKey: "google-public-secret",
        headers: undefined,
      });
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("consolidates Kimi Code and Moonshot platforms into one connect provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "kimi-coding", "kimi-for-coding");
      registerSingleModelProvider(registry, "moonshot-cn", "kimi-k2.6");
      registerSingleModelProvider(registry, "moonshot-ai", "kimi-k2.6");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry });

      const providers = await port.listProviders();

      expect(providers.map((provider) => provider.id)).toContain("kimi-coding");
      expect(providers.map((provider) => provider.id)).not.toContain("moonshot-cn");
      expect(providers.map((provider) => provider.id)).not.toContain("moonshot-ai");
      expect(providers.find((provider) => provider.id === "kimi-coding")).toMatchObject({
        name: "Kimi",
        group: "popular",
        modelProviders: ["kimi-coding", "moonshot-cn", "moonshot-ai"],
        modelCount: 3,
        credentialRef: "vault://kimi-coding/apiKey",
      });

      expect(port.listAuthMethods("kimi-coding")).toMatchObject([
        {
          id: "kimi_code_api_key",
          label: "Kimi Code",
          credentialProvider: "kimi-coding",
          modelProviderFilter: "kimi-coding",
          credentialRef: "vault://kimi-coding/apiKey",
        },
        {
          id: "moonshot_cn_api_key",
          label: "Moonshot AI Open Platform (moonshot.cn)",
          credentialProvider: "moonshot-cn",
          modelProviderFilter: "moonshot-cn",
          credentialRef: "vault://moonshot-cn/apiKey",
        },
        {
          id: "moonshot_ai_api_key",
          label: "Moonshot AI Open Platform (moonshot.ai)",
          credentialProvider: "moonshot-ai",
          modelProviderFilter: "moonshot-ai",
          credentialRef: "vault://moonshot-ai/apiKey",
        },
      ]);

      await port.connectApiKey("moonshot-cn", "moonshot-cn-secret");
      expect(registry.getAvailable().some((model) => model.provider === "moonshot-cn")).toBe(true);

      await port.disconnect("kimi-coding");
      expect(registry.getAvailable().some((model) => model.provider === "kimi-coding")).toBe(false);
      expect(registry.getAvailable().some((model) => model.provider === "moonshot-cn")).toBe(false);
      expect(registry.getAvailable().some((model) => model.provider === "moonshot-ai")).toBe(false);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("exposes DeepSeek as a direct API-key provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "provider-connection-test-key",
      DEEPSEEK_API_KEY: undefined,
    });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "deepseek", "deepseek-v4-flash");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry });

      const providers = await port.listProviders();
      const deepseek = providers.find((provider) => provider.id === "deepseek");

      expect(deepseek).toMatchObject({
        name: "DeepSeek",
        description: "API key",
        group: "popular",
        modelProviders: ["deepseek"],
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://deepseek/apiKey",
      });
      expect(port.listAuthMethods("deepseek")).toEqual([
        expect.objectContaining({
          id: "api_key",
          kind: "api_key",
          type: "api",
          credentialProvider: "deepseek",
          modelProviderFilter: "deepseek",
          credentialRef: "vault://deepseek/apiKey",
        }),
      ]);

      await port.connectApiKey("deepseek", "deepseek-secret");

      expect(registry.getAvailable().some((model) => model.provider === "deepseek")).toBe(true);
      expect(
        (await port.listProviders()).find((provider) => provider.id === "deepseek"),
      ).toMatchObject({
        connected: true,
        connectionSource: "vault",
        availableModelCount: 1,
      });

      await port.disconnect("deepseek");
      expect(registry.getAvailable().some((model) => model.provider === "deepseek")).toBe(false);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("does not connect DeepSeek from ambient provider env", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({
      BREWVA_VAULT_KEY: "provider-connection-test-key",
      DEEPSEEK_API_KEY: "ambient-deepseek-key",
    });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      configureCredentialVaultModelAuth({ runtime, authStore });
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "deepseek", "deepseek-v4-flash");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      expect(registry.getAvailable().some((model) => model.provider === "deepseek")).toBe(false);
      expect(
        (await port.listProviders()).find((provider) => provider.id === "deepseek"),
      ).toMatchObject({
        connected: false,
        connectionSource: "none",
        availableModelCount: 0,
      });
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("exposes OAuth auth methods for providers backed by hosted auth storage", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      for (const provider of ["openai", "openai-codex"]) {
        expect(port.listAuthMethods(provider).map((method) => method.label)).toEqual([
          "ChatGPT Pro/Plus (browser)",
          "ChatGPT Pro/Plus (headless)",
          "Manually enter API Key",
        ]);
      }
      expect(port.listAuthMethods("openai")).toMatchObject([
        {
          id: "chatgpt_browser",
          credentialProvider: "openai-codex",
          modelProviderFilter: "openai-codex",
        },
        {
          id: "chatgpt_headless",
          credentialProvider: "openai-codex",
          modelProviderFilter: "openai-codex",
        },
        {
          id: "api_key",
          credentialProvider: "openai",
          modelProviderFilter: "openai",
          credentialRef: "vault://openai/apiKey",
        },
      ]);
      const copilotMethods = port.listAuthMethods("github-copilot");
      expect(copilotMethods).toHaveLength(2);
      expect(copilotMethods[0]).toMatchObject({
        id: "github_copilot",
        kind: "oauth",
        type: "oauth",
      });
      expect(copilotMethods[0]?.prompts?.map((prompt) => prompt.key)).toEqual([
        "deploymentType",
        "enterpriseUrl",
      ]);
      expect(copilotMethods[1]).toMatchObject({
        id: "api_key",
        kind: "api_key",
        type: "api",
        credentialRef: "vault://github-copilot/token",
      });
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("OpenAI Codex browser OAuth uses the registered localhost port after cancelling a stale login server", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const blocker = await blockTcpPortUntilCancel(1455);
    const tokenRequestBodies: string[] = [];
    try {
      if (!blocker) {
        return;
      }
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = toRequestUrl(input);
          if (url === "https://auth.openai.com/oauth/token") {
            const body = init?.body;
            tokenRequestBodies.push(
              typeof body === "string"
                ? body
                : body instanceof URLSearchParams
                  ? body.toString()
                  : "",
            );
            return jsonResponse({
              access_token: "access-token",
              refresh_token: "refresh-token",
              expires_in: 3600,
            });
          }
          return INTRINSIC_FETCH(input, init);
        },
        { preconnect: INTRINSIC_FETCH.preconnect },
      );

      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      const authorization = await port.authorizeOAuth("openai", "chatgpt_browser");
      if (!authorization) {
        throw new Error("Expected OpenAI browser authorization.");
      }

      const authorizeUrl = new URL(authorization.url);
      const redirectUriValue = authorizeUrl.searchParams.get("redirect_uri");
      const state = authorizeUrl.searchParams.get("state");
      if (!redirectUriValue || !state) {
        throw new Error("Expected authorization URL to include redirect_uri and state.");
      }
      const redirectUri = new URL(redirectUriValue);
      expect(authorizeUrl.searchParams.get("scope")).toBe(
        "openid profile email offline_access api.connectors.read api.connectors.invoke",
      );
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("id_token_add_organizations")).toBe("true");
      expect(authorizeUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
      expect(authorizeUrl.searchParams.get("originator")).toBe("codex_cli_rs");
      expect(authorizeUrl.searchParams.get("code_challenge")?.length).toBeGreaterThan(40);
      expect(redirectUri.hostname).toBe("localhost");
      expect(redirectUri.pathname).toBe("/auth/callback");
      expect(redirectUri.port).toBe("1455");
      expect(authorization.instructions).toBe(
        "Approve the login in your browser or ChatGPT app. Brewva will continue after the browser redirects to localhost.",
      );
      expect(authorization.manualCode?.prompt).toContain("Paste the final redirect URL");

      const completion = port.completeOAuth("openai", "chatgpt_browser");
      const callbackResponse = await INTRINSIC_FETCH(
        `${redirectUri.origin}${redirectUri.pathname}?code=auth-code&state=${state}`,
      );
      expect(callbackResponse.status).toBe(200);
      await completion;

      expect(tokenRequestBodies).toHaveLength(1);
      expect(new URLSearchParams(tokenRequestBodies[0]).get("redirect_uri")).toBe(redirectUriValue);
      expect(new URLSearchParams(tokenRequestBodies[0]).get("code_verifier")?.length).toBe(43);
      expect(registry.getAvailable().some((model) => model.provider === "openai-codex")).toBe(true);
    } finally {
      await closeServer(blocker);
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("OpenAI Codex browser OAuth can complete from a pasted redirect URL", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const tokenRequestBodies: string[] = [];
    try {
      globalThis.fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = toRequestUrl(input);
          if (url === "https://auth.openai.com/oauth/token") {
            const body = init?.body;
            tokenRequestBodies.push(
              typeof body === "string"
                ? body
                : body instanceof URLSearchParams
                  ? body.toString()
                  : "",
            );
            return jsonResponse({
              access_token: "manual-access-token",
              refresh_token: "manual-refresh-token",
              expires_in: 3600,
            });
          }
          return INTRINSIC_FETCH(input, init);
        },
        { preconnect: INTRINSIC_FETCH.preconnect },
      );

      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      const authorization = await port.authorizeOAuth("openai", "chatgpt_browser");
      if (!authorization) {
        throw new Error("Expected OpenAI browser authorization.");
      }
      const authorizeUrl = new URL(authorization.url);
      const redirectUriValue = authorizeUrl.searchParams.get("redirect_uri");
      const state = authorizeUrl.searchParams.get("state");
      if (!redirectUriValue || !state) {
        throw new Error("Expected authorization URL to include redirect_uri and state.");
      }
      const redirectUri = new URL(redirectUriValue);

      const browserWait = port.completeOAuth("openai", "chatgpt_browser");
      await port.completeOAuth(
        "openai",
        "chatgpt_browser",
        `${redirectUri.origin}${redirectUri.pathname}?code=manual-auth-code&state=${state}`,
      );
      await browserWait;

      expect(tokenRequestBodies).toHaveLength(1);
      expect(new URLSearchParams(tokenRequestBodies[0]).get("code")).toBe("manual-auth-code");
      expect(authStore.get("openai-codex")).toMatchObject({
        type: "oauth",
        accessToken: "manual-access-token",
        refreshToken: "manual-refresh-token",
      });
      expect(registry.getAvailable().some((model) => model.provider === "openai-codex")).toBe(true);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("OpenAI Codex browser OAuth escapes callback error HTML", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      const authorization = await port.authorizeOAuth("openai", "chatgpt_browser");
      if (!authorization) {
        throw new Error("Expected OpenAI browser authorization.");
      }
      const authorizeUrl = new URL(authorization.url);
      const redirectUriValue = authorizeUrl.searchParams.get("redirect_uri");
      if (!redirectUriValue) {
        throw new Error("Expected authorization URL to include redirect_uri.");
      }
      const redirectUri = new URL(redirectUriValue);
      const completion = port.completeOAuth("openai", "chatgpt_browser").then(
        () => undefined,
        (error: unknown) => error,
      );
      const unsafeError = '<script>alert("x")</script>';

      const response = await INTRINSIC_FETCH(
        `${redirectUri.origin}${redirectUri.pathname}?error_description=${encodeURIComponent(
          unsafeError,
        )}`,
      );
      const body = await response.text();
      const rejection = await completion;

      expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(body).not.toContain('<script>alert("x")</script>');
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(unsafeError);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("OpenAI Codex browser OAuth explains fixed redirect port conflicts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const blocker = createServer((_req, res) => {
      res.writeHead(200);
      res.end("busy");
    });
    const bound = await new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        blocker.removeListener("error", onError);
        blocker.removeListener("listening", onListening);
      };
      const onError = (error: unknown) => {
        cleanup();
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: unknown }).code === "EADDRINUSE"
        ) {
          resolve(false);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve(true);
      };
      blocker.once("error", onError);
      blocker.once("listening", onListening);
      blocker.listen(1455, "127.0.0.1");
    });
    try {
      if (!bound) {
        return;
      }
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai", "gpt-5.4");
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.3-codex");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      let rejection: unknown;
      try {
        await port.authorizeOAuth("openai", "chatgpt_browser");
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("localhost:1455/auth/callback");
      expect((rejection as Error).message).toContain("registered with OpenAI");
    } finally {
      await closeServer(bound ? blocker : undefined);
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth follows the device flow and stores token credentials", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = toRequestUrl(input);
      const body = readJsonRequestBody(init);
      fetchCalls.push({ url, body });
      if (url === "https://github.com/login/device/code") {
        return jsonResponse({
          verification_uri_complete: "https://github.com/login/device?user_code=GH12-3456",
          verification_uri: "https://github.com/login/device",
          user_code: "GH12-3456",
          device_code: "device-code",
          interval: 5,
          expires_in: 900,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse({ access_token: "gho-copilot-token" });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      expect(
        registry
          .getAvailable()
          .some((model) => `${model.provider}/${model.id}` === "github-copilot/gpt-4o"),
      ).toBe(false);

      const authorization = await port.authorizeOAuth("github-copilot", "github_copilot", {
        deploymentType: "github.com",
      });

      expect(authorization).toMatchObject({
        url: "https://github.com/login/device?user_code=GH12-3456",
        method: "auto",
        instructions: "Enter code: GH12-3456",
        copyText: "GH12-3456",
      });

      await port.completeOAuth("github-copilot", "github_copilot");

      expect(authStore.get("github-copilot")).toMatchObject({
        type: "oauth",
        accessToken: "gho-copilot-token",
        refreshToken: "gho-copilot-token",
        expiresAt: 0,
        access: "gho-copilot-token",
        refresh: "gho-copilot-token",
        expires: 0,
      });
      expect(
        registry
          .getAvailable()
          .some((model) => `${model.provider}/${model.id}` === "github-copilot/gpt-4o"),
      ).toBe(true);
      expect(fetchCalls).toEqual([
        {
          url: "https://github.com/login/device/code",
          body: {
            client_id: "Ov23li8tweQw6odWQebz",
            scope: "read:user",
          },
        },
        {
          url: "https://github.com/login/oauth/access_token",
          body: {
            client_id: "Ov23li8tweQw6odWQebz",
            device_code: "device-code",
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
        },
      ]);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth targets GitHub Enterprise domains", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      fetchUrls.push(url);
      if (url === "https://company.ghe.com/login/device/code") {
        return jsonResponse({
          verification_uri: "https://company.ghe.com/login/device",
          user_code: "GH12-3456",
          device_code: "enterprise-device-code",
          interval: 5,
          expires_in: 900,
        });
      }
      if (url === "https://company.ghe.com/login/oauth/access_token") {
        return jsonResponse({ access_token: "ghu-enterprise-token" });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      const authorization = await port.authorizeOAuth("github-copilot", "github_copilot", {
        deploymentType: "enterprise",
        enterpriseUrl: "https://company.ghe.com/org",
      });

      expect(authorization).toMatchObject({
        url: "https://company.ghe.com/login/device",
        instructions: "Enter code: GH12-3456",
        copyText: "GH12-3456",
      });
      await port.completeOAuth("github-copilot", "github_copilot");

      expect(authStore.get("github-copilot")).toMatchObject({
        type: "oauth",
        accessToken: "ghu-enterprise-token",
        refreshToken: "ghu-enterprise-token",
        enterpriseUrl: "company.ghe.com",
      });
      expect(fetchUrls).toEqual([
        "https://company.ghe.com/login/device/code",
        "https://company.ghe.com/login/oauth/access_token",
      ]);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth reports terminal device-flow errors", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      if (url === "https://github.com/login/device/code") {
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: "GH12-3456",
          device_code: "device-code",
          interval: 5,
          expires_in: 900,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse({ error: "access_denied" }, 400);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      await port.authorizeOAuth("github-copilot", "github_copilot", {
        deploymentType: "github.com",
      });

      let rejection: unknown;
      try {
        await port.completeOAuth("github-copilot", "github_copilot");
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe("GitHub device authorization was denied.");
      expect(authStore.get("github-copilot")).toBe(undefined);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth reports alternate device expiry errors", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      if (url === "https://github.com/login/device/code") {
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: "GH12-3456",
          device_code: "device-code",
          interval: 5,
          expires_in: 900,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        return jsonResponse({ error: "token_expired" });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      await port.authorizeOAuth("github-copilot", "github_copilot", {
        deploymentType: "github.com",
      });

      let rejection: unknown;
      try {
        await port.completeOAuth("github-copilot", "github_copilot");
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        "GitHub device authorization expired. Reopen /model to request a new code.",
      );
      expect(authStore.get("github-copilot")).toBe(undefined);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth surfaces device-code start error details", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      if (url === "https://github.com/login/device/code") {
        return jsonResponse({ error: "device_flow_disabled" }, 403);
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      let rejection: unknown;
      try {
        await port.authorizeOAuth("github-copilot", "github_copilot", {
          deploymentType: "github.com",
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain(
        "Failed to start GitHub device authorization: 403",
      );
      expect((rejection as Error).message).toContain("device_flow_disabled");
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GitHub Copilot OAuth honors device-code expiry before retrying", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    let tokenPolls = 0;
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      if (url === "https://github.com/login/device/code") {
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: "GH12-3456",
          device_code: "device-code",
          interval: 5,
          expires_in: 1,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        tokenPolls += 1;
        return jsonResponse({ error: "authorization_pending" });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "github-copilot", "gpt-4o");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      await port.authorizeOAuth("github-copilot", "github_copilot", {
        deploymentType: "github.com",
      });

      let rejection: unknown;
      try {
        await port.completeOAuth("github-copilot", "github_copilot");
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe(
        "GitHub device authorization expired. Reopen /model to request a new code.",
      );
      expect(tokenPolls).toBe(1);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("accepts injected provider auth handlers without changing the TUI connection port", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const authorizeCalls: Array<{ methodId: string; inputs?: Record<string, string> }> = [];
    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerDemoProvider(registry);
      const customHandler: ProviderAuthHandler = {
        provider: "demo",
        listAuthMethods() {
          return [
            {
              id: "demo_oauth",
              kind: "oauth",
              type: "oauth",
              label: "Demo OAuth",
              prompts: [
                {
                  type: "text",
                  key: "team",
                  message: "Team slug",
                  placeholder: "platform",
                },
              ],
            },
          ];
        },
        async authorizeOAuth(methodId, inputs) {
          authorizeCalls.push({ methodId, inputs });
          return {
            url: "https://auth.example.test/demo",
            method: "code",
            instructions: "Paste the authorization code.",
            async complete(code) {
              return {
                type: "oauth",
                accessToken: `demo-access-${code}`,
                access: `demo-access-${code}`,
              };
            },
          };
        },
      };
      const port = createProviderConnectionPort({
        runtime,
        modelRegistry: registry,
        authStore,
        authHandlers: [customHandler],
      });

      expect(port.listAuthMethods("demo").map((method) => method.label)).toEqual([
        "Demo OAuth",
        "API key",
      ]);

      const authorization = await port.authorizeOAuth("demo", "demo_oauth", { team: "platform" });
      expect(authorization).toMatchObject({
        url: "https://auth.example.test/demo",
        method: "code",
      });
      await port.completeOAuth("demo", "demo_oauth", "CODE-1");

      expect(authorizeCalls).toEqual([{ methodId: "demo_oauth", inputs: { team: "platform" } }]);
      expect(authStore.get("demo")).toMatchObject({
        type: "oauth",
        accessToken: "demo-access-CODE-1",
      });
      expect(registry.getAvailable().some((model) => model.provider === "demo")).toBe(true);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stores completed OpenAI ChatGPT OAuth credentials and makes models available", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-provider-connection-"));
    const restoreEnv = patchProcessEnv({ BREWVA_VAULT_KEY: "provider-connection-test-key" });
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = toRequestUrl(input);
      fetchUrls.push(url);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "CODE-1234",
          interval: "1",
        });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
        });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const runtime = createRuntimeInstanceFixture({ cwd: workspace });
      const authStore = HostedAuthStore.inMemory();
      const registry = HostedModelRegistry.inMemory(authStore);
      registerSingleModelProvider(registry, "openai-codex", "gpt-5.4");
      const port = createProviderConnectionPort({ runtime, modelRegistry: registry, authStore });

      expect(
        registry
          .getAvailable()
          .some((model) => `${model.provider}/${model.id}` === "openai-codex/gpt-5.4"),
      ).toBe(false);

      const authorization = await port.authorizeOAuth("openai", "chatgpt_headless");

      expect(authorization).toMatchObject({
        url: "https://auth.openai.com/codex/device",
        method: "auto",
        instructions: "Enter code: CODE-1234",
        copyText: "CODE-1234",
      });

      await port.completeOAuth("openai", "chatgpt_headless");

      expect(authStore.get("openai-codex")).toMatchObject({
        type: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        access: "access-token",
        refresh: "refresh-token",
      });
      expect(
        registry
          .getAvailable()
          .some((model) => `${model.provider}/${model.id}` === "openai-codex/gpt-5.4"),
      ).toBe(true);
      expect(
        (await port.listProviders()).find((provider) => provider.id === "openai"),
      ).toMatchObject({
        connected: true,
        connectionSource: "oauth",
        availableModelCount: 1,
      });
      expect(fetchUrls).toEqual([
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        "https://auth.openai.com/api/accounts/deviceauth/token",
        "https://auth.openai.com/oauth/token",
      ]);
    } finally {
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
