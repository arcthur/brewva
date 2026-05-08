import { resolveBrewvaModelSelection } from "@brewva/brewva-gateway/model-routing";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { MODEL_PRESET_SELECT_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { BREWVA_THINKING_LEVELS } from "@brewva/brewva-substrate/contracts";
import type { InternalHostPlugin } from "@brewva/brewva-substrate/host-api";
import type { BrewvaMutableModelCatalog } from "@brewva/brewva-substrate/provider";
import { createHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type {
  BrewvaModelPreset,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
} from "@brewva/brewva-substrate/session";
import { createHostedTurnPipeline } from "../runtime-plugins/index.js";
import {
  createHostedModelServices as createLocalHostedModelServices,
  type HostedModelRegistry,
} from "./hosted-model-registry.js";
import type {
  HostedSessionBackendAdapter,
  HostedSessionBackendCreateResult,
  HostedSessionBackendModelRegistry,
  HostedSessionModelServices,
  HostedSessionPersistenceBackend,
  HostedSessionServicesBundle,
} from "./hosted-session-backend-contract.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionCustomTool,
  HostedSessionSettings,
} from "./hosted-session-driver.js";
import {
  createHostedSettingsHandle as createLocalHostedSettingsHandle,
  readHostedSettingsHandle,
} from "./hosted-settings-backend.js";
import { createBrewvaManagedAgentSession } from "./managed-agent-session.js";
import {
  cloneModelPreset,
  cloneModelPresetState,
  createSyntheticDefaultModelPreset,
  findModelPreset,
} from "./model-presets.js";
import { HostedRuntimeTapeSessionStore } from "./runtime-projection-session-store.js";

const DEFAULT_THINKING_LEVEL: BrewvaPromptThinkingLevel = "medium";

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.5",
  "openai-codex": "gpt-5.3-codex",
  google: "gemini-2.5-pro",
  deepseek: "deepseek-v4-flash",
  "github-copilot": "gpt-4o",
  openrouter: "openai/gpt-5.1-codex",
  "kimi-coding": "kimi-for-coding",
  "moonshot-cn": "kimi-k2.6",
  "moonshot-ai": "kimi-k2.6",
};

type HostedRegisteredModel = NonNullable<
  ReturnType<HostedSessionBackendModelRegistry["getAll"]>[number]
>;

async function resolveHostedInitialModel(
  modelRegistry: HostedSessionBackendModelRegistry,
  sessionManager: HostedSessionPersistenceBackend,
  requestedModel: HostedRegisteredModel | undefined,
  modelPresetState: BrewvaModelPresetState,
): Promise<{
  model: HostedRegisteredModel | undefined;
  modelFallbackMessage?: string;
  presetThinkingLevel?: string;
  hasExistingSession: boolean;
  hasThinkingEntry: boolean;
  existingThinkingLevel?: string;
}> {
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry =
    sessionManager.hasSessionEntryType?.("thinking_level_change") ??
    sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
  const existingThinkingLevel =
    hasExistingSession && typeof existingSession.thinkingLevel === "string"
      ? existingSession.thinkingLevel
      : undefined;
  let modelFallbackMessage: string | undefined;

  if (requestedModel) {
    const resolvedRequestedModel = modelRegistry.find(requestedModel.provider, requestedModel.id);
    if (resolvedRequestedModel && modelRegistry.hasConfiguredAuth(resolvedRequestedModel)) {
      return {
        model: resolvedRequestedModel,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
    modelFallbackMessage = `Could not use requested model ${requestedModel.provider}/${requestedModel.id}: provider auth is not connected`;
  }

  const activePreset = findModelPreset(modelPresetState);
  const presetMainModel = activePreset?.mainModel?.trim();
  if (presetMainModel) {
    try {
      const presetSelection = resolveBrewvaModelSelection(presetMainModel, modelRegistry);
      if (presetSelection.model && modelRegistry.hasConfiguredAuth(presetSelection.model)) {
        return {
          model: presetSelection.model,
          presetThinkingLevel: presetSelection.thinkingLevel,
          modelFallbackMessage,
          hasExistingSession,
          hasThinkingEntry,
          existingThinkingLevel,
        };
      }
      if (presetSelection.model) {
        modelFallbackMessage = `Could not use preset model ${presetSelection.model.provider}/${presetSelection.model.id}: provider auth is not connected`;
      }
    } catch (error) {
      modelFallbackMessage = error instanceof Error ? error.message : "Could not use preset model";
    }
  }

  if (hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(
      existingSession.model.provider,
      existingSession.model.modelId,
    );
    if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
      return {
        model: restoredModel,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
    modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
  }

  const availableModels = await Promise.resolve(modelRegistry.getAvailable());

  for (const [provider, defaultId] of Object.entries(DEFAULT_MODEL_PER_PROVIDER)) {
    const preferredModel = availableModels.find(
      (model) => model.provider === provider && model.id === defaultId,
    );
    if (preferredModel) {
      return {
        model: preferredModel,
        modelFallbackMessage:
          modelFallbackMessage && preferredModel
            ? `${modelFallbackMessage}. Using ${preferredModel.provider}/${preferredModel.id}`
            : modelFallbackMessage,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
  }

  const firstAvailable = availableModels[0];
  if (firstAvailable) {
    return {
      model: firstAvailable,
      modelFallbackMessage:
        modelFallbackMessage && firstAvailable
          ? `${modelFallbackMessage}. Using ${firstAvailable.provider}/${firstAvailable.id}`
          : modelFallbackMessage,
      hasExistingSession,
      hasThinkingEntry,
      existingThinkingLevel,
    };
  }

  return {
    model: undefined,
    modelFallbackMessage:
      modelFallbackMessage ??
      "No models available. Configure an API key or provider auth, then select a model.",
    hasExistingSession,
    hasThinkingEntry,
    existingThinkingLevel,
  };
}

function stateWithReplayActivePreset(
  settingsState: BrewvaModelPresetState,
  activePreset: BrewvaModelPreset,
): BrewvaModelPresetState {
  const replayPreset = cloneModelPreset(activePreset);
  const presets = settingsState.presets.some((preset) => preset.name === replayPreset.name)
    ? settingsState.presets.map((preset) =>
        preset.name === replayPreset.name ? replayPreset : cloneModelPreset(preset),
      )
    : [replayPreset, ...settingsState.presets.map((preset) => cloneModelPreset(preset))];
  return {
    activeName: replayPreset.name,
    defaultName: settingsState.defaultName,
    presets,
  };
}

function stateWithHistoricalSyntheticDefault(
  settingsState: BrewvaModelPresetState,
): BrewvaModelPresetState {
  const defaultPreset = createSyntheticDefaultModelPreset();
  return {
    activeName: defaultPreset.name,
    defaultName: settingsState.defaultName,
    presets: [
      defaultPreset,
      ...settingsState.presets
        .filter((preset) => preset.name !== defaultPreset.name)
        .map((preset) => cloneModelPreset(preset)),
    ],
  };
}

function resolveHostedThinkingLevel(input: {
  requestedThinkingLevel?: string;
  hasExistingSession: boolean;
  hasThinkingEntry: boolean;
  existingThinkingLevel?: string;
  defaultThinkingLevel?: string;
  model?: HostedRegisteredModel;
}): BrewvaPromptThinkingLevel {
  const requestedThinkingLevel = normalizeHostedThinkingLevel(input.requestedThinkingLevel);
  const defaultThinkingLevel =
    normalizeHostedThinkingLevel(input.defaultThinkingLevel) ?? DEFAULT_THINKING_LEVEL;
  const existingThinkingLevel = normalizeHostedThinkingLevel(input.existingThinkingLevel);
  let thinkingLevel =
    requestedThinkingLevel ??
    (input.hasExistingSession
      ? input.hasThinkingEntry
        ? existingThinkingLevel
        : defaultThinkingLevel
      : defaultThinkingLevel);

  if (!input.model || !input.model.reasoning) {
    thinkingLevel = "off";
  }

  return thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

function normalizeHostedThinkingLevel(
  thinkingLevel: string | undefined,
): BrewvaPromptThinkingLevel | undefined {
  if (!thinkingLevel) {
    return undefined;
  }
  return BREWVA_THINKING_LEVELS.includes(thinkingLevel as BrewvaPromptThinkingLevel)
    ? (thinkingLevel as BrewvaPromptThinkingLevel)
    : undefined;
}

function createHostedLocalSettingsHandle(cwd: string, agentDir: string): HostedSessionSettings {
  return createLocalHostedSettingsHandle(cwd, agentDir);
}

function createHostedLocalModelServices(agentDir: string): HostedSessionModelServices {
  return createLocalHostedModelServices(agentDir);
}

async function createHostedLocalSessionServicesBundle(input: {
  agentDir: string;
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: BrewvaRuntime;
  runtimePlugins?: readonly InternalHostPlugin[];
  sessionId?: string;
}): Promise<HostedSessionServicesBundle> {
  const settingsManager = readHostedSettingsHandle(input.settings);
  const runtime = input.runtime ?? new BrewvaRuntime({ cwd: input.cwd });
  const runtimePlugins =
    input.runtimePlugins && input.runtimePlugins.length > 0
      ? input.runtimePlugins
      : [createHostedTurnPipeline({ runtime, registerTools: false })];
  const resourceLoader = await createHostedResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    runtimePlugins,
  });
  return {
    agentDir: input.agentDir,
    cwd: input.cwd,
    runtime,
    settingsManager,
    resourceLoader,
    sessionManager: new HostedRuntimeTapeSessionStore(runtime, input.cwd, input.sessionId),
    runtimePlugins,
  };
}

async function createHostedLocalSessionResult(input: {
  services: HostedSessionServicesBundle;
  modelRegistry: HostedSessionBackendModelRegistry;
  modelCatalog: BrewvaMutableModelCatalog;
  options: CreateHostedManagedSessionOptions;
}): Promise<HostedSessionBackendCreateResult> {
  const sessionManager = input.services.sessionManager;
  const resourceLoader = input.services.resourceLoader;
  const customTools: HostedSessionCustomTool[] = input.options.customTools ?? [];
  const settingsPresetState = input.services.settingsManager.getModelPresetState();
  const restoredContext = sessionManager.buildSessionContext();
  const restoredBranch = sessionManager.getBranch();
  const hasPresetSelectionEntry =
    sessionManager.hasSessionEntryType?.(MODEL_PRESET_SELECT_EVENT_TYPE) ??
    restoredBranch.some((entry) => entry.type === MODEL_PRESET_SELECT_EVENT_TYPE);
  const modelPresetState = cloneModelPresetState(
    hasPresetSelectionEntry
      ? stateWithReplayActivePreset(settingsPresetState, restoredContext.activeModelPreset)
      : restoredBranch.length > 0
        ? stateWithHistoricalSyntheticDefault(settingsPresetState)
        : settingsPresetState,
  );
  const sessionResolution = await resolveHostedInitialModel(
    input.modelRegistry,
    sessionManager,
    input.options.model,
    modelPresetState,
  );
  const thinkingLevel = resolveHostedThinkingLevel({
    requestedThinkingLevel: input.options.thinkingLevel,
    hasExistingSession: sessionResolution.hasExistingSession,
    hasThinkingEntry: sessionResolution.hasThinkingEntry,
    existingThinkingLevel: sessionResolution.existingThinkingLevel,
    defaultThinkingLevel:
      sessionResolution.presetThinkingLevel ??
      input.services.settingsManager.getDefaultThinkingLevel() ??
      undefined,
    model: sessionResolution.model,
  });

  if (!sessionResolution.hasExistingSession) {
    sessionManager.appendModelPresetSelection({
      presetName: modelPresetState.activeName,
      source: "startup",
      mainModel: findModelPreset(modelPresetState)?.mainModel,
      subagentModels: findModelPreset(modelPresetState)?.subagentModels,
      synthetic: findModelPreset(modelPresetState)?.synthetic,
    });
    if (sessionResolution.model) {
      sessionManager.appendModelChange(
        sessionResolution.model.provider,
        sessionResolution.model.id,
      );
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  } else if (!sessionResolution.hasThinkingEntry) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  return {
    session: await createBrewvaManagedAgentSession({
      cwd: input.services.cwd,
      agentDir: input.services.agentDir,
      sessionStore: sessionManager,
      settings: input.services.settingsManager,
      runtime: input.services.runtime,
      modelCatalog: input.modelCatalog,
      resourceLoader,
      runtimePlugins: input.services.runtimePlugins,
      customTools,
      ui: input.options.ui,
      logger: input.options.logger,
      initialModel: sessionResolution.model,
      initialThinkingLevel: thinkingLevel,
      initialModelPresetState: modelPresetState,
    }),
    modelFallbackMessage: sessionResolution.modelFallbackMessage,
  };
}

export function createHostedSessionBackendAdapter(): HostedSessionBackendAdapter {
  return {
    createSettingsHandle: createHostedLocalSettingsHandle,
    createModelServices: createHostedLocalModelServices,
    createServicesBundle: createHostedLocalSessionServicesBundle,
    createSessionResult: createHostedLocalSessionResult,
  };
}

export type { HostedModelRegistry };
