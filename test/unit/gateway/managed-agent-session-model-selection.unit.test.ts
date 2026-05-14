import { describe, expect, test } from "bun:test";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type {
  BrewvaDiffPreferences,
  BrewvaModelPreferences,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
  BrewvaShellViewPreferences,
} from "@brewva/brewva-substrate/session";
import {
  createFallbackModelPresetState,
  ManagedSessionModelSelectionController,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/model-selection.js";
import { ManagedSessionSettingsView } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/preferences.js";

const TEST_MODEL: BrewvaRegisteredModel = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

function createCatalog(models: BrewvaRegisteredModel[]): BrewvaMutableModelCatalog {
  return {
    getAvailable() {
      return models;
    },
    getAll() {
      return models;
    },
    find(provider: string, id: string) {
      return models.find((model) => model.provider === provider && model.id === id);
    },
    hasConfiguredAuth() {
      return true;
    },
    async getApiKeyAndHeaders() {
      return { ok: true as const, apiKey: "test-key", headers: {} };
    },
  } as unknown as BrewvaMutableModelCatalog;
}

describe("managed-agent-session preferences", () => {
  test("forwards all preference reads and writes to the settings port", () => {
    const calls: string[] = [];
    const modelPreferences: BrewvaModelPreferences = { recent: [], favorite: [] };
    const diffPreferences: BrewvaDiffPreferences = { style: "auto", wrapMode: "word" };
    const shellViewPreferences: BrewvaShellViewPreferences = {
      showThinking: true,
      toolDetails: true,
    };
    const view = new ManagedSessionSettingsView({
      getQuietStartup() {
        calls.push("getQuietStartup");
        return true;
      },
      getModelPreferences() {
        calls.push("getModelPreferences");
        return modelPreferences;
      },
      setModelPreferences() {
        calls.push("setModelPreferences");
      },
      getDiffPreferences() {
        calls.push("getDiffPreferences");
        return diffPreferences;
      },
      setDiffPreferences() {
        calls.push("setDiffPreferences");
      },
      getShellViewPreferences() {
        calls.push("getShellViewPreferences");
        return shellViewPreferences;
      },
      setShellViewPreferences() {
        calls.push("setShellViewPreferences");
      },
    });

    expect(view.getQuietStartup()).toBe(true);
    expect(view.getModelPreferences()).toBe(modelPreferences);
    view.setModelPreferences(modelPreferences);
    expect(view.getDiffPreferences()).toBe(diffPreferences);
    view.setDiffPreferences(diffPreferences);
    expect(view.getShellViewPreferences()).toBe(shellViewPreferences);
    view.setShellViewPreferences(shellViewPreferences);
    expect(calls).toEqual([
      "getQuietStartup",
      "getModelPreferences",
      "setModelPreferences",
      "getDiffPreferences",
      "setDiffPreferences",
      "getShellViewPreferences",
      "setShellViewPreferences",
    ]);
  });
});

describe("managed-agent-session model selection", () => {
  test("queues preset for next turn and consumes the latest queued selection", async () => {
    let currentModel: BrewvaRegisteredModel | undefined = TEST_MODEL;
    let currentThinkingLevel: BrewvaPromptThinkingLevel = "off";
    const selectedPresets: string[] = [];
    const controller = new ManagedSessionModelSelectionController({
      initialState: {
        ...createFallbackModelPresetState("Default"),
        presets: [
          ...createFallbackModelPresetState("Default").presets,
          { name: "High", mainModel: "openai/gpt-5.4-mini:high", subagentModels: {} },
          { name: "Low", mainModel: "openai/gpt-5.4-mini:low", subagentModels: {} },
        ],
      },
      catalog: createCatalog([TEST_MODEL]),
      getCurrentModel: () => currentModel,
      getCurrentThinkingLevel: () => currentThinkingLevel,
      compactBeforeModelDownshiftIfNeeded: async () => undefined,
      setCurrentModel: (model) => {
        currentModel = model;
      },
      applyThinkingLevel: (level) => {
        currentThinkingLevel = level;
      },
      clearProviderCacheSessionState: async () => undefined,
      appendModelPresetSelection: ({ presetName }) => {
        selectedPresets.push(presetName);
      },
      appendModelChange: () => undefined,
      emitModelSelect: async () => undefined,
    });

    expect(controller.queueModelPresetForNextTurn("High").queued).toBe(true);
    expect(controller.queueModelPresetForNextTurn("Low").selectedName).toBe("Low");
    await controller.applyQueuedModelPreset();

    expect(controller.getState().activeName).toBe("Low");
    expect(controller.getState().pendingName).toBe(undefined);
    expect(currentThinkingLevel as BrewvaPromptThinkingLevel).toBe("low");
    expect(selectedPresets).toEqual(["Low"]);
  });

  test("preserves explicit same-name preset reselection in tape callbacks without fake model change", async () => {
    let currentModel: BrewvaRegisteredModel | undefined = TEST_MODEL;
    let currentThinkingLevel: BrewvaPromptThinkingLevel = "off";
    const presetEvents: string[] = [];
    let modelChangeCount = 0;
    let emitCount = 0;
    const initialState: BrewvaModelPresetState = {
      activeName: "Fast",
      defaultName: "Default",
      presets: [
        { name: "Default", synthetic: true, subagentModels: {} },
        { name: "Fast", mainModel: "openai/gpt-5.4-mini:high", subagentModels: {} },
      ],
    };
    const controller = new ManagedSessionModelSelectionController({
      initialState,
      catalog: createCatalog([TEST_MODEL]),
      getCurrentModel: () => currentModel,
      getCurrentThinkingLevel: () => currentThinkingLevel,
      compactBeforeModelDownshiftIfNeeded: async () => undefined,
      setCurrentModel: (model) => {
        currentModel = model;
      },
      applyThinkingLevel: (level) => {
        currentThinkingLevel = level;
      },
      clearProviderCacheSessionState: async () => undefined,
      appendModelPresetSelection: ({ presetName }) => {
        presetEvents.push(presetName);
      },
      appendModelChange: () => {
        modelChangeCount += 1;
      },
      emitModelSelect: async () => {
        emitCount += 1;
      },
    });

    const result = await controller.selectModelPreset({ name: "Fast", source: "session" });

    expect(result).toMatchObject({
      selectedName: "Fast",
      previousName: "Fast",
      modelChanged: false,
      queued: false,
    });
    expect(currentThinkingLevel as BrewvaPromptThinkingLevel).toBe("high");
    expect(presetEvents).toEqual(["Fast"]);
    expect(modelChangeCount).toBe(0);
    expect(emitCount).toBe(0);
  });

  test("persists explicit model selections even when the model is already current", async () => {
    let currentModel: BrewvaRegisteredModel | undefined = TEST_MODEL;
    let currentThinkingLevel: BrewvaPromptThinkingLevel = "off";
    let selectedModel: { provider: string; id: string } | undefined;
    let modelChangeCount = 0;
    const controller = new ManagedSessionModelSelectionController({
      initialState: createFallbackModelPresetState("Default"),
      catalog: createCatalog([TEST_MODEL]),
      getCurrentModel: () => currentModel,
      getCurrentThinkingLevel: () => currentThinkingLevel,
      compactBeforeModelDownshiftIfNeeded: async () => undefined,
      setCurrentModel: (model) => {
        currentModel = model;
      },
      applyThinkingLevel: (level) => {
        currentThinkingLevel = level;
      },
      setSelectedModelPreference: (model) => {
        selectedModel = model;
      },
      clearProviderCacheSessionState: async () => undefined,
      appendModelPresetSelection: () => undefined,
      appendModelChange: () => {
        modelChangeCount += 1;
      },
      emitModelSelect: async () => undefined,
    });

    await controller.setModel(TEST_MODEL);

    expect(selectedModel).toEqual({
      provider: TEST_MODEL.provider,
      id: TEST_MODEL.id,
    });
    expect(modelChangeCount).toBe(0);
  });
});
