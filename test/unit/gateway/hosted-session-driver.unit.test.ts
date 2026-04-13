import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostedModelRegistry } from "../../../packages/brewva-gateway/src/host/hosted-model-registry.js";
import {
  createHostedSessionDriver,
  createHostedSettingsManager,
} from "../../../packages/brewva-gateway/src/host/hosted-session-driver.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeHostedSettings(
  agentDir: string,
  settings: {
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel?: string;
  },
): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

describe("hosted session driver", () => {
  test("creates a hosted runtime from the configured default model and thinking level", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-bootstrap-default");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultProvider: "anthropic",
      defaultModel: "restore-model",
      defaultThinkingLevel: "high",
    });

    const driver = createHostedSessionDriver(agentDir);
    driver.modelCatalog.registerProvider("anthropic", {
      baseUrl: "https://anthropic.example.com/v1",
      apiKey: "ANTHROPIC_KEY",
      models: [
        {
          id: "restore-model",
          name: "Restore Model",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      ],
    });
    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("restore-model");
    expect(result.session.thinkingLevel).toBe("high");
    expect(result.modelFallbackMessage).toBeUndefined();

    await result.session.abort();
    result.session.dispose();
  });

  test("prefers an explicit requested model while inheriting default thinking level", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-explicit-model");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      defaultThinkingLevel: "low",
    });

    const driver = createHostedSessionDriver(agentDir);
    driver.modelCatalog.registerProvider("anthropic", {
      baseUrl: "https://anthropic.example.com/v1",
      apiKey: "ANTHROPIC_KEY",
      models: [
        {
          id: "explicit-model",
          name: "Explicit Model",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      ],
    });
    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      requestedModel: driver.modelCatalog.find("anthropic", "explicit-model"),
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("explicit-model");
    expect(result.session.thinkingLevel).toBe("low");
    expect(result.modelFallbackMessage).toBeUndefined();

    await result.session.abort();
    result.session.dispose();
  });

  test("uses Pi-aligned provider defaults when no explicit model exists", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-provider-default");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    driver.modelCatalog.registerProvider("openai", {
      baseUrl: "https://openai.example.com/v1",
      apiKey: "OPENAI_KEY",
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      ],
    });
    driver.modelCatalog.registerProvider("anthropic", {
      baseUrl: "https://anthropic.example.com/v1",
      apiKey: "ANTHROPIC_KEY",
      models: [
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        },
      ],
    });

    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("claude-opus-4-6");
    expect(result.session.thinkingLevel).toBe("medium");
    expect(result.modelFallbackMessage).toBeUndefined();

    await result.session.abort();
    result.session.dispose();
  });

  test("clamps hosted runtime thinking level to off for non-reasoning models", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-thinking-clamp");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 512,
        },
      ],
    });

    writeHostedSettings(agentDir, {
      defaultProvider: "demo",
      defaultModel: "alpha",
      defaultThinkingLevel: "high",
    });

    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("demo");
    expect(result.session.model?.id).toBe("alpha");
    expect(result.session.thinkingLevel).toBe("off");

    await result.session.abort();
    result.session.dispose();
  });

  test("keeps Pi model handles internal to the driver surface", () => {
    const workspace = createTestWorkspace("hosted-session-driver-model-services");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);

    expect(typeof driver.modelCatalog.getAll).toBe("function");
    expect("authStorage" in driver).toBe(false);
    expect("sessionModelRegistry" in driver).toBe(false);
    expect(typeof driver.createRuntime).toBe("function");
    expect("resolveBootstrapSelection" in driver).toBe(false);
    expect("createServices" in driver).toBe(false);
    expect("createSession" in driver).toBe(false);
  });

  test("keeps Pi settings and hosted session services handles internal", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-settings");
    const agentDir = join(workspace, ".brewva-agent");
    const settings = createHostedSettingsManager(workspace, agentDir);
    const driver = createHostedSessionDriver(agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 2_048,
        },
      ],
    });

    expect(typeof settings.view.getImageAutoResize()).toBe("boolean");
    expect(typeof settings.view.getQuietStartup()).toBe("boolean");
    expect("piSettingsManager" in settings).toBe(false);

    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      requestedModel: driver.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    expect(result.services).toBeDefined();
    expect(result.services.cwd).toBe(workspace);
    expect(Array.isArray(result.services.diagnostics)).toBe(true);
    expect(result.services.settings).toBe(settings.view);
    expect(result.services.modelCatalog.find("demo", "alpha")).toEqual(
      driver.modelCatalog.find("demo", "alpha"),
    );
    expect(typeof result.services.createSession).toBe("function");

    await result.session.abort();
    result.session.dispose();
  });

  test("reuses a cohesive hosted session services contract to create additional sessions", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-services-contract");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 2_048,
        },
      ],
    });

    const initial = await driver.createRuntime({
      cwd: workspace,
      settings,
      requestedModel: driver.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    await initial.session.abort();
    initial.session.dispose();

    const replay = await initial.services.createSession({
      model: driver.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    expect(replay.session.model?.provider).toBe("demo");
    expect(replay.session.model?.id).toBe("alpha");
    await replay.session.abort();
    replay.session.dispose();
  });

  test("creates a hosted runtime from a Brewva-owned runtime handle", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-services-session");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 2_048,
        },
      ],
    });

    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      customTools: [],
      requestedModel: driver.modelCatalog.find("demo", "alpha"),
      requestedThinkingLevel: "medium",
    });

    expect(result.session.sessionManager.getSessionId()).toBeString();
    expect(result.session.model?.provider).toBe("demo");
    expect(result.session.model?.id).toBe("alpha");

    await result.session.abort();
    result.session.dispose();
  });

  test("wraps the Pi session in a Brewva-owned managed session surface", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-session-wrapper");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_768,
          maxTokens: 2_048,
        },
      ],
    });

    const result = await driver.createRuntime({
      cwd: workspace,
      settings,
      requestedModel: driver.modelCatalog.find("demo", "alpha"),
      requestedThinkingLevel: "medium",
      customTools: [],
    });

    expect("agent" in result.session).toBe(false);
    expect("extensionRunner" in result.session).toBe(false);
    expect("sessionFile" in result.session).toBe(false);
    expect("getSessionDir" in result.session.sessionManager).toBe(false);
    expect("getImageAutoResize" in result.session.settingsManager).toBe(false);

    await result.session.abort();
    result.session.dispose();
  });

  test("keeps model catalog reads on Brewva-owned state after driver construction", () => {
    const workspace = createTestWorkspace("hosted-session-driver-catalog-state");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);
    const baselineModels = driver.modelCatalog.getAll();
    const firstModel = baselineModels[0];

    expect(firstModel).toBeDefined();

    const originalGetAllDescriptor = Object.getOwnPropertyDescriptor(
      HostedModelRegistry.prototype,
      "getAll",
    );
    const originalFindDescriptor = Object.getOwnPropertyDescriptor(
      HostedModelRegistry.prototype,
      "find",
    );

    HostedModelRegistry.prototype.getAll = function getAll(): never {
      throw new Error("pi_registry_read_leak");
    };
    HostedModelRegistry.prototype.find = function find(): never {
      throw new Error("pi_registry_read_leak");
    };

    try {
      expect(driver.modelCatalog.getAll()).toEqual(baselineModels);
      expect(driver.modelCatalog.find(firstModel!.provider, firstModel!.id)).toEqual(firstModel);
    } finally {
      Object.defineProperty(HostedModelRegistry.prototype, "getAll", originalGetAllDescriptor!);
      Object.defineProperty(HostedModelRegistry.prototype, "find", originalFindDescriptor!);
    }
  });

  test("preserves static models.json provider and model request headers in catalog auth resolution", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-static-request-config");
    const agentDir = join(workspace, ".brewva-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            anthropic: {
              headers: {
                "x-provider": "provider-header",
              },
              modelOverrides: {
                "claude-sonnet-4-5": {
                  headers: {
                    "x-model": "model-header",
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const driver = createHostedSessionDriver(agentDir);
    const model = driver.modelCatalog.find("anthropic", "claude-sonnet-4-5");

    expect(model).toBeDefined();
    const auth = await driver.modelCatalog.getApiKeyAndHeaders(model!);
    expect(auth).toEqual({
      ok: true,
      headers: {
        "x-provider": "provider-header",
        "x-model": "model-header",
      },
    });
  });

  test("preserves static custom provider auth semantics from models.json", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-custom-provider-auth");
    const agentDir = join(workspace, ".brewva-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), "{}", "utf8");
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            demo: {
              baseUrl: "https://demo.example.com/v1",
              apiKey: "DEMO_KEY",
              authHeader: true,
              api: "openai-completions",
              models: [
                {
                  id: "alpha",
                  name: "Alpha",
                  reasoning: true,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 1024,
                  maxTokens: 256,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const driver = createHostedSessionDriver(agentDir);
    const model = driver.modelCatalog.find("demo", "alpha");

    expect(model).toBeDefined();
    expect(driver.modelCatalog.hasConfiguredAuth(model!)).toBe(true);
    const auth = await driver.modelCatalog.getApiKeyAndHeaders(model!);
    expect(auth).toEqual({
      ok: true,
      apiKey: "DEMO_KEY",
      headers: {
        Authorization: "Bearer DEMO_KEY",
      },
    });
  });

  test("keeps dynamic provider request headers out of model descriptors while preserving request auth", async () => {
    const workspace = createTestWorkspace("hosted-session-driver-dynamic-request-headers");
    const agentDir = join(workspace, ".brewva-agent");
    const driver = createHostedSessionDriver(agentDir);

    driver.modelCatalog.registerProvider("demo", {
      baseUrl: "https://demo.example.com/v1",
      apiKey: "DEMO_KEY",
      authHeader: true,
      headers: {
        "x-provider": "provider-header",
      },
      models: [
        {
          id: "alpha",
          name: "Alpha",
          api: "openai-completions",
          reasoning: true,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 1024,
          maxTokens: 256,
          headers: {
            "x-model": "model-header",
          },
        },
      ],
    });

    const model = driver.modelCatalog.find("demo", "alpha");
    expect(model).toBeDefined();
    expect(model?.headers).toBeUndefined();
    const auth = await driver.modelCatalog.getApiKeyAndHeaders(model!);
    expect(auth).toEqual({
      ok: true,
      apiKey: "DEMO_KEY",
      headers: {
        Authorization: "Bearer DEMO_KEY",
        "x-provider": "provider-header",
        "x-model": "model-header",
      },
    });
  });
});
