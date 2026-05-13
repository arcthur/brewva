import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { createHostedBehaviorHostAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import {
  type CreateHostedSessionRuntimeOptions,
  type HostedManagedSessionRuntimeResult,
  createHostedSessionFactory,
  createHostedSettingsManager,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/session-factory.js";
import { HostedModelRegistry } from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/hosted-model-registry.js";
import { readHostedSettingsHandle } from "../../../packages/brewva-gateway/src/hosted/internal/session/settings/settings-store.js";
import type { StoredSessionMessage } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/runtime-session-transcript.js";
import { patchProcessEnv } from "../../helpers/global-state.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

function writeHostedSettings(agentDir: string, settings: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

function writeProjectHostedSettings(workspace: string, settings: Record<string, unknown>): void {
  const settingsDir = join(workspace, ".brewva", "agent");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

function registerAnthropicModels(
  factory: ReturnType<typeof createHostedSessionFactory>,
  modelIds: readonly string[],
): void {
  factory.modelCatalog.registerProvider("anthropic", {
    baseUrl: "https://anthropic.example.com/v1",
    apiKey: "ANTHROPIC_KEY",
    models: modelIds.map((id) => ({
      id,
      name: id,
      api: "anthropic-messages",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 16_384,
    })),
  });
}

function createTestHostedRuntime(
  factory: ReturnType<typeof createHostedSessionFactory>,
  options: CreateHostedSessionRuntimeOptions,
): Promise<HostedManagedSessionRuntimeResult> {
  const runtime = options.runtime ?? createHostedTestRuntime({ cwd: options.cwd });
  return factory.createRuntime({
    ...options,
    runtime,
    extensions: [
      createHostedBehaviorHostAdapter({ runtime, registerTools: false }),
      ...(options.extensions ?? []),
    ],
  });
}

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`${label} must be available for this test`);
  }
  return value;
}

describe("hosted session factory", () => {
  test("creates a hosted runtime from the configured default model preset", async () => {
    const workspace = createTestWorkspace("session-factory-bootstrap-preset");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultModelPreset: "Claude Lead",
      defaultThinkingLevel: "low",
      modelPresets: {
        "Claude Lead": {
          mainModel: "anthropic/preset-main:high",
          subagentModels: {
            advisor: "openai/gpt-5.5:medium",
          },
        },
      },
    });

    const factory = createHostedSessionFactory(agentDir);
    factory.modelCatalog.registerProvider("anthropic", {
      baseUrl: "https://anthropic.example.com/v1",
      apiKey: "ANTHROPIC_KEY",
      models: [
        {
          id: "preset-main",
          name: "Preset Main",
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
    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("preset-main");
    expect(result.session.thinkingLevel).toBe("high");
    expect(result.session.getModelPresetState?.().activeName).toBe("Claude Lead");
    expect(result.modelFallbackMessage).toBe(undefined);

    await result.session.abort();
    result.session.dispose();
  });

  test("rejects unknown default model preset settings", () => {
    const workspace = createTestWorkspace("session-factory-unknown-preset");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultModelPreset: "Missing",
      modelPresets: {
        "Claude Lead": {
          mainModel: "anthropic/preset-main:high",
        },
      },
    });

    const settings = readHostedSettingsHandle(createHostedSettingsManager(workspace, agentDir));

    expect(() => settings.getModelPresetState()).toThrow("Unknown default model preset: Missing");
  });

  test("rejects malformed model preset settings", () => {
    const workspace = createTestWorkspace("session-factory-malformed-preset");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultModelPreset: "Claude Lead",
      modelPresets: {
        " Claude Lead ": {
          mainModel: "anthropic/preset-main:high",
        },
      },
    });

    const settings = readHostedSettingsHandle(createHostedSettingsManager(workspace, agentDir));

    expect(() => settings.getModelPresetState()).toThrow("Model preset names must be trimmed");
  });

  test("loads project hosted settings from the Brewva agent directory", () => {
    const workspace = createTestWorkspace("session-factory-project-settings");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultModelPreset: "Global",
      modelPresets: {
        Global: {
          mainModel: "anthropic/global-main:low",
        },
      },
    });
    writeProjectHostedSettings(workspace, {
      defaultModelPreset: "Project",
      modelPresets: {
        Project: {
          mainModel: "anthropic/project-main:high",
          subagentModels: {
            advisor: "anthropic/project-advisor:medium",
          },
        },
      },
    });

    const settings = readHostedSettingsHandle(createHostedSettingsManager(workspace, agentDir));

    expect(settings.getModelPresetState()).toMatchObject({
      activeName: "Project",
      defaultName: "Project",
      presets: expect.arrayContaining([
        expect.objectContaining({
          name: "Project",
          mainModel: "anthropic/project-main:high",
          subagentModels: {
            advisor: "anthropic/project-advisor:medium",
          },
        }),
      ]),
    });
  });

  test("rejects removed legacy default model settings", () => {
    const workspace = createTestWorkspace("session-factory-legacy-default-model");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultProvider: "anthropic",
      defaultModel: "restore-model",
      defaultThinkingLevel: "high",
    });

    expect(() => createHostedSettingsManager(workspace, agentDir)).toThrow(
      "Removed hosted model default settings",
    );
  });

  test("replays historical sessions as synthetic Default instead of authored Default", async () => {
    const workspace = createTestWorkspace("session-factory-historical-default");
    const agentDir = join(workspace, ".brewva-agent");
    const sessionId = "agent-session:historical-default";
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const historicalMessage = {
      role: "user",
      content: [{ type: "text", text: "historical prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage;
    store.appendModelChange("anthropic", "restored-main");
    store.appendMessage(historicalMessage);
    writeHostedSettings(agentDir, {
      modelPresets: {
        Default: {
          mainModel: "anthropic/current-default:high",
        },
      },
    });

    const factory = createHostedSessionFactory(agentDir);
    registerAnthropicModels(factory, ["restored-main", "current-default"]);
    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      runtime,
      sessionId,
      customTools: [],
    });

    expect(result.session.model?.id).toBe("restored-main");
    expect(result.session.getModelPresetState?.().activeName).toBe("Default");
    expect(result.session.getModelPresetState?.().presets[0]).toMatchObject({
      name: "Default",
      synthetic: true,
      mainModel: undefined,
    });

    await result.session.abort();
    result.session.dispose();
  });

  test("replays selected preset model from session tape instead of current settings", async () => {
    const workspace = createTestWorkspace("session-factory-preset-replay-snapshot");
    const agentDir = join(workspace, ".brewva-agent");
    const sessionId = "agent-session:preset-replay-snapshot";
    const runtime = createHostedTestRuntime({ cwd: workspace });
    const store = new HostedRuntimeTapeSessionStore(runtime, sessionId);
    const replayedMessage = {
      role: "user",
      content: [{ type: "text", text: "replayed prompt" }],
      timestamp: Date.now(),
    } as StoredSessionMessage;
    store.appendModelPresetSelection({
      presetName: "Claude Lead",
      previousPresetName: "Default",
      source: "tui",
      mainModel: "anthropic/replayed-main:high",
      subagentModels: {
        advisor: "anthropic/replayed-advisor:medium",
      },
    });
    store.appendModelChange("anthropic", "replayed-main");
    store.appendMessage(replayedMessage);
    writeHostedSettings(agentDir, {
      defaultModelPreset: "Claude Lead",
      modelPresets: {
        "Claude Lead": {
          mainModel: "anthropic/current-main:low",
          subagentModels: {
            advisor: "anthropic/current-advisor:low",
          },
        },
      },
    });

    const factory = createHostedSessionFactory(agentDir);
    registerAnthropicModels(factory, [
      "replayed-main",
      "replayed-advisor",
      "current-main",
      "current-advisor",
    ]);
    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      runtime,
      sessionId,
      customTools: [],
    });

    expect(result.session.model?.id).toBe("replayed-main");
    expect(result.session.thinkingLevel).toBe("high");
    expect(result.session.getModelPresetState?.().presets).toContainEqual(
      expect.objectContaining({
        name: "Claude Lead",
        mainModel: "anthropic/replayed-main:high",
        subagentModels: {
          advisor: "anthropic/replayed-advisor:medium",
        },
      }),
    );

    await result.session.abort();
    result.session.dispose();
  });

  test("keeps preset thinking suffix session-local when switching presets", async () => {
    const workspace = createTestWorkspace("session-factory-preset-thinking-local");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultThinkingLevel: "low",
      modelPresets: {
        Default: {
          mainModel: "anthropic/default-main:low",
        },
        "Claude Lead": {
          mainModel: "anthropic/claude-main:high",
        },
      },
    });

    const factory = createHostedSessionFactory(agentDir);
    registerAnthropicModels(factory, ["default-main", "claude-main"]);
    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      customTools: [],
    });

    await result.session.selectModelPreset?.({ name: "Claude Lead", source: "session" });

    const persistedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      defaultThinkingLevel?: string;
    };
    expect(result.session.thinkingLevel).toBe("high");
    expect(persistedSettings.defaultThinkingLevel).toBe("low");

    await result.session.abort();
    result.session.dispose();
  });

  test("prefers an explicit requested model while inheriting default thinking level", async () => {
    const workspace = createTestWorkspace("session-factory-explicit-model");
    const agentDir = join(workspace, ".brewva-agent");
    writeHostedSettings(agentDir, {
      defaultThinkingLevel: "low",
    });

    const factory = createHostedSessionFactory(agentDir);
    factory.modelCatalog.registerProvider("anthropic", {
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
    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      requestedModel: factory.modelCatalog.find("anthropic", "explicit-model"),
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("explicit-model");
    expect(result.session.thinkingLevel).toBe("low");
    expect(result.modelFallbackMessage).toBe(undefined);

    await result.session.abort();
    result.session.dispose();
  });

  test("does not bootstrap an explicit requested model without provider auth", async () => {
    const restoreEnv = patchProcessEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_OAUTH_TOKEN: undefined,
      COPILOT_GITHUB_TOKEN: undefined,
      DEEPSEEK_API_KEY: undefined,
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      KIMI_API_KEY: undefined,
      MOONSHOT_AI_API_KEY: undefined,
      MOONSHOT_CN_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    });
    try {
      const workspace = createTestWorkspace("session-factory-explicit-model-no-auth");
      const agentDir = join(workspace, ".brewva-agent");
      const factory = createHostedSessionFactory(agentDir);
      factory.modelCatalog.registerProvider("demo", {
        baseUrl: "https://demo.example.com/v1",
        models: [
          {
            id: "explicit-model",
            name: "Explicit Model",
            api: "openai-completions",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 16_384,
          },
        ],
      });
      const settings = createHostedSettingsManager(workspace, agentDir);
      const result = await createTestHostedRuntime(factory, {
        cwd: workspace,
        settings,
        requestedModel: factory.modelCatalog.find("demo", "explicit-model"),
        customTools: [],
      });

      expect(result.session.model).toBe(undefined);
      expect(result.modelFallbackMessage).toBe(
        "Could not use requested model demo/explicit-model: provider auth is not connected",
      );

      await result.session.abort();
      result.session.dispose();
    } finally {
      restoreEnv();
    }
  });

  test("uses Brewva-hosted provider defaults when no explicit model exists", async () => {
    const workspace = createTestWorkspace("session-factory-provider-default");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    factory.modelCatalog.registerProvider("openai", {
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
    factory.modelCatalog.registerProvider("anthropic", {
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

    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      customTools: [],
    });

    expect(result.session.model?.provider).toBe("anthropic");
    expect(result.session.model?.id).toBe("claude-opus-4-6");
    expect(result.session.thinkingLevel).toBe("medium");
    expect(result.modelFallbackMessage).toBe(undefined);

    await result.session.abort();
    result.session.dispose();
  });

  test("clamps hosted runtime thinking level to off for non-reasoning models", async () => {
    const workspace = createTestWorkspace("session-factory-thinking-clamp");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);

    factory.modelCatalog.registerProvider("demo", {
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
      defaultThinkingLevel: "high",
      modelPresets: {
        Default: {
          mainModel: "demo/alpha",
        },
      },
    });

    const settings = createHostedSettingsManager(workspace, agentDir);
    const result = await createTestHostedRuntime(factory, {
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

  test("keeps hosted model handles internal to the factory surface", () => {
    const workspace = createTestWorkspace("session-factory-model-services");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);

    expect(typeof factory.modelCatalog.getAll).toBe("function");
    expect("authStorage" in factory).toBe(false);
    expect("sessionModelRegistry" in factory).toBe(false);
    expect(typeof factory.createRuntime).toBe("function");
    expect("resolveBootstrapSelection" in factory).toBe(false);
    expect("createServices" in factory).toBe(false);
    expect("createSession" in factory).toBe(false);
  });

  test("keeps hosted settings and session services handles internal", async () => {
    const workspace = createTestWorkspace("session-factory-settings");
    const agentDir = join(workspace, ".brewva-agent");
    const settings = createHostedSettingsManager(workspace, agentDir);
    const factory = createHostedSessionFactory(agentDir);

    factory.modelCatalog.registerProvider("demo", {
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
    expect("hostedSettingsManager" in settings).toBe(false);

    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      requestedModel: factory.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    const services = requireDefined(result.services, "hosted session services");
    expect(services.cwd).toBe(workspace);
    expect(Array.isArray(services.diagnostics)).toBe(true);
    expect(services.settings).toBe(settings.view);
    expect(services.modelCatalog.find("demo", "alpha")).toEqual(
      factory.modelCatalog.find("demo", "alpha"),
    );
    expect(typeof services.createSession).toBe("function");

    await result.session.abort();
    result.session.dispose();
  });

  test("persists shell view preferences through the hosted settings store", () => {
    const workspace = createTestWorkspace("session-factory-shell-view-settings");
    const agentDir = join(workspace, ".brewva-agent");
    const settings = readHostedSettingsHandle(createHostedSettingsManager(workspace, agentDir));

    expect(settings.getShellViewPreferences()).toEqual({
      showThinking: true,
      toolDetails: true,
    });

    settings.setShellViewPreferences({
      showThinking: false,
      toolDetails: false,
    });

    expect(settings.getShellViewPreferences()).toEqual({
      showThinking: false,
      toolDetails: false,
    });
    expect(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).shellViewPreferences,
    ).toEqual({
      showThinking: false,
      toolDetails: false,
    });

    const reloaded = readHostedSettingsHandle(createHostedSettingsManager(workspace, agentDir));
    expect(reloaded.getShellViewPreferences()).toEqual({
      showThinking: false,
      toolDetails: false,
    });
  });

  test("reuses a cohesive hosted session services contract to create additional sessions", async () => {
    const workspace = createTestWorkspace("session-factory-services-contract");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    factory.modelCatalog.registerProvider("demo", {
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

    const initial = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      requestedModel: factory.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    await initial.session.abort();
    initial.session.dispose();

    const replay = await initial.services.createSession({
      model: factory.modelCatalog.find("demo", "alpha"),
      customTools: [],
    });

    expect(replay.session.model?.provider).toBe("demo");
    expect(replay.session.model?.id).toBe("alpha");
    await replay.session.abort();
    replay.session.dispose();
  });

  test("creates a hosted runtime from a Brewva-owned runtime handle", async () => {
    const workspace = createTestWorkspace("session-factory-services-session");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    factory.modelCatalog.registerProvider("demo", {
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

    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      customTools: [],
      requestedModel: factory.modelCatalog.find("demo", "alpha"),
      requestedThinkingLevel: "medium",
    });

    expect(result.session.sessionManager.getSessionId()).toBeString();
    expect(result.session.model?.provider).toBe("demo");
    expect(result.session.model?.id).toBe("alpha");

    await result.session.abort();
    result.session.dispose();
  });

  test("wraps the hosted session in a Brewva-owned managed session surface", async () => {
    const workspace = createTestWorkspace("session-factory-session-wrapper");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);
    const settings = createHostedSettingsManager(workspace, agentDir);

    factory.modelCatalog.registerProvider("demo", {
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

    const result = await createTestHostedRuntime(factory, {
      cwd: workspace,
      settings,
      requestedModel: factory.modelCatalog.find("demo", "alpha"),
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

  test("keeps model catalog reads on Brewva-owned state after factory construction", () => {
    const workspace = createTestWorkspace("session-factory-catalog-state");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);
    const baselineModels = factory.modelCatalog.getAll();
    const firstModel = requireDefined(baselineModels[0], "first catalog model");

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
      expect(factory.modelCatalog.getAll()).toEqual(baselineModels);
      expect(factory.modelCatalog.find(firstModel.provider, firstModel.id)).toEqual(firstModel);
    } finally {
      Object.defineProperty(HostedModelRegistry.prototype, "getAll", originalGetAllDescriptor!);
      Object.defineProperty(HostedModelRegistry.prototype, "find", originalFindDescriptor!);
    }
  });

  test("preserves static models.json provider and model request headers in catalog auth resolution", async () => {
    const workspace = createTestWorkspace("session-factory-static-request-config");
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

    const factory = createHostedSessionFactory(agentDir);
    const model = requireDefined(
      factory.modelCatalog.find("anthropic", "claude-sonnet-4-5"),
      "static Anthropic model",
    );

    const auth = await factory.modelCatalog.getApiKeyAndHeaders(model);
    expect(auth).toEqual({
      ok: true,
      headers: {
        "x-provider": "provider-header",
        "x-model": "model-header",
      },
    });
  });

  test("preserves static custom provider auth semantics from models.json", async () => {
    const workspace = createTestWorkspace("session-factory-custom-provider-auth");
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

    const factory = createHostedSessionFactory(agentDir);
    const model = requireDefined(factory.modelCatalog.find("demo", "alpha"), "custom demo model");

    expect(factory.modelCatalog.hasConfiguredAuth(model)).toBe(true);
    const auth = await factory.modelCatalog.getApiKeyAndHeaders(model);
    expect(auth).toEqual({
      ok: true,
      apiKey: "DEMO_KEY",
      headers: {
        Authorization: "Bearer DEMO_KEY",
      },
    });
  });

  test("keeps dynamic provider request headers out of model descriptors while preserving request auth", async () => {
    const workspace = createTestWorkspace("session-factory-dynamic-request-headers");
    const agentDir = join(workspace, ".brewva-agent");
    const factory = createHostedSessionFactory(agentDir);

    factory.modelCatalog.registerProvider("demo", {
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

    const model = requireDefined(factory.modelCatalog.find("demo", "alpha"), "dynamic demo model");
    expect(model.headers).toBe(undefined);
    const auth = await factory.modelCatalog.getApiKeyAndHeaders(model);
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
