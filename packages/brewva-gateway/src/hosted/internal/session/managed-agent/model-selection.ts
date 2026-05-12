import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetSelectionRequest,
  BrewvaModelPresetSelectionResult,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import { resolveBrewvaModelSelection } from "../../../../policy/model-routing/api.js";
import {
  cloneModelPresetState,
  DEFAULT_MODEL_PRESET_NAME,
  findModelPreset,
} from "../settings/model-presets.js";

export function createFallbackModelPresetState(
  activeName = DEFAULT_MODEL_PRESET_NAME,
): BrewvaModelPresetState {
  return {
    activeName,
    defaultName: DEFAULT_MODEL_PRESET_NAME,
    presets: [
      {
        name: DEFAULT_MODEL_PRESET_NAME,
        subagentModels: {},
        synthetic: true,
      },
    ],
  };
}

export function resolvePresetModelSelection(
  modelText: string,
  catalog: BrewvaMutableModelCatalog,
): { model: BrewvaRegisteredModel; thinkingLevel?: BrewvaPromptThinkingLevel; modelText: string } {
  const selection = resolveBrewvaModelSelection(modelText, catalog);
  if (!selection.model) {
    throw new Error(`Model "${modelText}" was not found in the configured Brewva model registry.`);
  }
  return {
    model: selection.model,
    thinkingLevel: selection.thinkingLevel,
    modelText: selection.thinkingLevel
      ? `${selection.model.provider}/${selection.model.id}:${selection.thinkingLevel}`
      : `${selection.model.provider}/${selection.model.id}`,
  };
}

function hasModelChanged(
  previousModel: BrewvaSessionModelDescriptor | undefined,
  nextModel: BrewvaSessionModelDescriptor,
): boolean {
  return (
    !previousModel ||
    previousModel.provider !== nextModel.provider ||
    previousModel.id !== nextModel.id
  );
}

export interface ManagedSessionModelSelectionControllerOptions {
  initialState: BrewvaModelPresetState;
  catalog: BrewvaMutableModelCatalog;
  getCurrentModel: () => BrewvaSessionModelDescriptor | undefined;
  getCurrentThinkingLevel: () => BrewvaPromptThinkingLevel;
  compactBeforeModelDownshiftIfNeeded: (
    previousModel: BrewvaSessionModelDescriptor | undefined,
    nextModel: BrewvaSessionModelDescriptor,
  ) => Promise<void>;
  setCurrentModel: (model: BrewvaRegisteredModel) => void;
  applyThinkingLevel: (
    level: BrewvaPromptThinkingLevel,
    options: { persistDefault: boolean },
  ) => void;
  clearProviderCacheSessionState: () => Promise<void>;
  appendModelPresetSelection: (input: {
    presetName: string;
    previousPresetName?: string;
    source?: string;
    mainModel?: string;
    subagentModels?: Record<string, string>;
    synthetic?: boolean;
  }) => void;
  appendModelChange: (provider: string, modelId: string) => void;
  emitModelSelect: (input: {
    model: { provider: string; id: string };
    previousModel?: { provider: string; id: string };
    source: "preset" | "set";
  }) => Promise<void>;
}

export class ManagedSessionModelSelectionController {
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #getCurrentModel: ManagedSessionModelSelectionControllerOptions["getCurrentModel"];
  readonly #getCurrentThinkingLevel: ManagedSessionModelSelectionControllerOptions["getCurrentThinkingLevel"];
  readonly #compactBeforeModelDownshiftIfNeeded: ManagedSessionModelSelectionControllerOptions["compactBeforeModelDownshiftIfNeeded"];
  readonly #setCurrentModel: ManagedSessionModelSelectionControllerOptions["setCurrentModel"];
  readonly #applyThinkingLevel: ManagedSessionModelSelectionControllerOptions["applyThinkingLevel"];
  readonly #clearProviderCacheSessionState: ManagedSessionModelSelectionControllerOptions["clearProviderCacheSessionState"];
  readonly #appendModelPresetSelection: ManagedSessionModelSelectionControllerOptions["appendModelPresetSelection"];
  readonly #appendModelChange: ManagedSessionModelSelectionControllerOptions["appendModelChange"];
  readonly #emitModelSelect: ManagedSessionModelSelectionControllerOptions["emitModelSelect"];
  #state: BrewvaModelPresetState;

  constructor(options: ManagedSessionModelSelectionControllerOptions) {
    this.#state = cloneModelPresetState(options.initialState);
    this.#catalog = options.catalog;
    this.#getCurrentModel = options.getCurrentModel;
    this.#getCurrentThinkingLevel = options.getCurrentThinkingLevel;
    this.#compactBeforeModelDownshiftIfNeeded = options.compactBeforeModelDownshiftIfNeeded;
    this.#setCurrentModel = options.setCurrentModel;
    this.#applyThinkingLevel = options.applyThinkingLevel;
    this.#clearProviderCacheSessionState = options.clearProviderCacheSessionState;
    this.#appendModelPresetSelection = options.appendModelPresetSelection;
    this.#appendModelChange = options.appendModelChange;
    this.#emitModelSelect = options.emitModelSelect;
  }

  getState(): BrewvaModelPresetState {
    return cloneModelPresetState(this.#state);
  }

  queueModelPresetForNextTurn(name: string): BrewvaModelPresetSelectionResult {
    const preset = findModelPreset(this.#state, name);
    if (!preset) {
      throw new Error(`Unknown model preset: ${name}`);
    }
    this.#state = {
      ...this.#state,
      pendingName: preset.name,
    };
    return {
      selectedName: preset.name,
      previousName: this.#state.activeName,
      modelChanged: false,
      queued: true,
      effectiveMainModel: preset.mainModel,
    };
  }

  async applyQueuedModelPreset(): Promise<void> {
    const pendingName = this.#state.pendingName;
    if (!pendingName) {
      return;
    }
    await this.selectModelPreset({ name: pendingName, source: "queued" });
  }

  async selectModelPreset(
    request: BrewvaModelPresetSelectionRequest,
  ): Promise<BrewvaModelPresetSelectionResult> {
    const preset = findModelPreset(this.#state, request.name);
    if (!preset) {
      throw new Error(`Unknown model preset: ${request.name}`);
    }
    const selection = preset.mainModel
      ? resolvePresetModelSelection(preset.mainModel, this.#catalog)
      : undefined;
    if (selection && !this.#catalog.hasConfiguredAuth(selection.model)) {
      throw new Error(`No API key for ${selection.model.provider}/${selection.model.id}`);
    }
    const previousName = this.#state.activeName;
    const previousModel = this.#getCurrentModel();
    this.#state = {
      ...this.#state,
      activeName: preset.name,
      pendingName: undefined,
    };
    this.#appendModelPresetSelection({
      presetName: preset.name,
      previousPresetName: previousName,
      source: request.source ?? "session",
      mainModel: preset.mainModel,
      subagentModels: preset.subagentModels,
      synthetic: preset.synthetic,
    });

    let modelChanged = false;
    if (selection) {
      await this.#compactBeforeModelDownshiftIfNeeded(previousModel, selection.model);
      this.#setCurrentModel(selection.model);
      this.#applyThinkingLevel(selection.thinkingLevel ?? this.#getCurrentThinkingLevel(), {
        persistDefault: false,
      });
      modelChanged = hasModelChanged(previousModel, selection.model);
      if (modelChanged) {
        await this.#clearProviderCacheSessionState();
        this.#appendModelChange(selection.model.provider, selection.model.id);
        await this.#emitModelSelect({
          model: { provider: selection.model.provider, id: selection.model.id },
          previousModel: previousModel
            ? { provider: previousModel.provider, id: previousModel.id }
            : undefined,
          source: "preset",
        });
      }
    }

    return {
      selectedName: preset.name,
      previousName,
      modelChanged,
      queued: false,
      effectiveMainModel: preset.mainModel,
    };
  }

  async setModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    const resolved = this.#catalog.find(model.provider, model.id);
    if (!resolved) {
      throw new Error(`Unknown model: ${model.provider}/${model.id}`);
    }
    if (!this.#catalog.hasConfiguredAuth(resolved)) {
      throw new Error(`No API key for ${resolved.provider}/${resolved.id}`);
    }

    const previousModel = this.#getCurrentModel();
    await this.#compactBeforeModelDownshiftIfNeeded(previousModel, resolved);
    this.#setCurrentModel(resolved);
    this.#applyThinkingLevel(this.#getCurrentThinkingLevel(), { persistDefault: true });

    if (!hasModelChanged(previousModel, resolved)) {
      return;
    }
    await this.#clearProviderCacheSessionState();
    this.#appendModelChange(resolved.provider, resolved.id);
    await this.#emitModelSelect({
      model: { provider: resolved.provider, id: resolved.id },
      previousModel: previousModel
        ? { provider: previousModel.provider, id: previousModel.id }
        : undefined,
      source: "set",
    });
  }
}
