import type { InternalHostPlugin } from "@brewva/brewva-substrate/host-api";
import type { BrewvaMutableModelCatalog } from "@brewva/brewva-substrate/provider";
import { createHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import {
  BREWVA_THINKING_LEVELS,
  type BrewvaModelPreferenceRef,
  type BrewvaModelPreset,
  type BrewvaModelPresetState,
  type BrewvaPromptThinkingLevel,
} from "@brewva/brewva-substrate/session";
import { MODEL_PRESET_SELECT_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { resolveBrewvaModelSelection } from "../../../policy/model-routing/api.js";
import { createBrewvaManagedAgentSession } from "./managed-agent/session.js";
import { HostedRuntimeTapeSessionStore } from "./projection/runtime-projection-session-store.js";
import { createHostedRuntimeAdapter } from "./runtime-ports.js";
import type { HostedRuntimeAdapterPort } from "./runtime-ports.js";
import { toHostedRuntimeAdapterPort } from "./runtime-ports.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionCustomTool,
  HostedSessionSettings,
} from "./session-factory.js";
import type {
  HostedSessionCreateResult,
  HostedSessionModelRegistry,
  HostedSessionModelServices,
  HostedSessionPersistenceStore,
  HostedSessionServicesBundle,
} from "./session-services.js";
import {
  createHostedModelServices as createLocalHostedModelServices,
  type HostedModelRegistry,
} from "./settings/hosted-model-registry.js";
import {
  cloneModelPreset,
  cloneModelPresetState,
  createSyntheticDefaultModelPreset,
  findModelPreset,
  resolvePresetRoleModel,
} from "./settings/model-presets.js";
import {
  createHostedSettingsHandle as createLocalHostedSettingsHandle,
  readHostedSettingsHandle,
} from "./settings/settings-store.js";

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

type HostedRegisteredModel = NonNullable<ReturnType<HostedSessionModelRegistry["getAll"]>[number]>;

async function resolveHostedInitialModel(
  modelRegistry: HostedSessionModelRegistry,
  sessionManager: HostedSessionPersistenceStore,
  requestedModel: HostedRegisteredModel | undefined,
  selectedModelPreference: BrewvaModelPreferenceRef | undefined,
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
  const presetDefaultModel = resolvePresetRoleModel(activePreset, "default")?.trim();
  if (presetDefaultModel) {
    try {
      const presetSelection = resolveBrewvaModelSelection(presetDefaultModel, modelRegistry);
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

  if (!hasExistingSession && selectedModelPreference) {
    const selectedModel = modelRegistry.find(
      selectedModelPreference.provider,
      selectedModelPreference.id,
    );
    if (selectedModel && modelRegistry.hasConfiguredAuth(selectedModel)) {
      return {
        model: selectedModel,
        modelFallbackMessage,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
    modelFallbackMessage = selectedModel
      ? `Could not restore selected model ${selectedModel.provider}/${selectedModel.id}: provider auth is not connected`
      : `Could not restore selected model ${selectedModelPreference.provider}/${selectedModelPreference.id}: model is not available`;
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

export function createHostedSessionSettingsHandle(
  cwd: string,
  agentDir: string,
): HostedSessionSettings {
  return createLocalHostedSettingsHandle(cwd, agentDir);
}

export function createHostedSessionModelServices(agentDir: string): HostedSessionModelServices {
  return createLocalHostedModelServices(agentDir);
}

export async function createHostedSessionServicesBundle(input: {
  agentDir: string;
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: HostedRuntimeAdapterPort;
  extensions?: readonly InternalHostPlugin[];
  sessionId?: string;
  deferPersistenceUntilPrompt?: boolean;
}): Promise<HostedSessionServicesBundle> {
  const settingsManager = readHostedSettingsHandle(input.settings);
  const runtime = toHostedRuntimeAdapterPort(
    input.runtime ?? createHostedRuntimeAdapter({ cwd: input.cwd }),
  );
  const extensions = input.extensions ?? [];
  const resourceLoader = await createHostedResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    runtimePlugins: extensions,
  });
  return {
    agentDir: input.agentDir,
    cwd: input.cwd,
    runtime,
    settingsManager,
    resourceLoader,
    sessionManager: new HostedRuntimeTapeSessionStore(runtime, input.sessionId, {
      deferInitialPersistence: input.deferPersistenceUntilPrompt,
    }),
    extensions,
  };
}

export async function createHostedSessionResult(input: {
  services: HostedSessionServicesBundle;
  modelRegistry: HostedSessionModelRegistry;
  modelCatalog: BrewvaMutableModelCatalog;
  options: CreateHostedManagedSessionOptions;
}): Promise<HostedSessionCreateResult> {
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
    input.services.settingsManager.getSelectedModelPreference(),
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
    const activePreset = findModelPreset(modelPresetState);
    const initialEntries = {
      modelPresetSelection: {
        presetName: modelPresetState.activeName,
        source: "startup",
        roles: activePreset?.roles,
        synthetic: activePreset?.synthetic,
      },
      modelChange: sessionResolution.model
        ? {
            provider: sessionResolution.model.provider,
            modelId: sessionResolution.model.id,
          }
        : undefined,
      thinkingLevel,
    };
    if (input.options.deferPersistenceUntilPrompt) {
      sessionManager.deferInitialSessionEntries?.(initialEntries);
    } else {
      sessionManager.appendModelPresetSelection(initialEntries.modelPresetSelection);
      if (initialEntries.modelChange) {
        sessionManager.appendModelChange(
          initialEntries.modelChange.provider,
          initialEntries.modelChange.modelId,
        );
      }
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
  } else if (!sessionResolution.hasThinkingEntry) {
    if (input.options.deferPersistenceUntilPrompt) {
      sessionManager.deferInitialSessionEntries?.({ thinkingLevel });
    } else {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
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
      extensions: input.services.extensions,
      customTools,
      ui: input.options.ui,
      logger: input.options.logger,
      deferPersistenceUntilPrompt: input.options.deferPersistenceUntilPrompt,
      onInitialPersistence: input.options.onInitialPersistence
        ? () => input.options.onInitialPersistence?.(sessionManager.getSessionId())
        : undefined,
      initialModel: sessionResolution.model,
      initialModelRole: input.options.modelRole,
      initialThinkingLevel: thinkingLevel,
      initialModelPresetState: modelPresetState,
    }),
    modelFallbackMessage: sessionResolution.modelFallbackMessage,
  };
}

export type {
  HostedSessionAuthStore,
  HostedSessionCreateResult,
  HostedSessionModelRegistry,
  HostedSessionModelServices,
  HostedSessionPersistenceStore,
  HostedSessionServicesBundle,
} from "./session-services.js";
export type { HostedModelRegistry };
