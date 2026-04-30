import type { BrewvaModelPreset, BrewvaModelPresetState } from "@brewva/brewva-substrate";

export const DEFAULT_MODEL_PRESET_NAME = "Default";

export interface HostedModelPresetSettingsShape {
  defaultModelPreset?: unknown;
  modelPresets?: Record<string, unknown>;
}

function readOptionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new Error(`${field} must be trimmed`);
  }
  return value;
}

function readSubagentModels(value: unknown, presetName: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`modelPresets.${presetName}.subagentModels must be an object`);
  }
  const models: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawKey.trim().length === 0) {
      throw new Error(`modelPresets.${presetName}.subagentModels keys must be non-empty`);
    }
    if (rawKey !== rawKey.trim()) {
      throw new Error(`modelPresets.${presetName}.subagentModels keys must be trimmed`);
    }
    models[rawKey] = readOptionalTrimmedString(
      rawValue,
      `modelPresets.${presetName}.subagentModels.${rawKey}`,
    )!;
  }
  return models;
}

function readPresetName(name: string): string {
  if (name.trim().length === 0) {
    throw new Error("Model preset names must be non-empty");
  }
  if (name !== name.trim()) {
    throw new Error("Model preset names must be trimmed");
  }
  return name;
}

function readPreset(name: string, value: unknown): BrewvaModelPreset | undefined {
  const presetName = readPresetName(name);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`modelPresets.${presetName} must be an object`);
  }
  const record = value as Record<string, unknown>;
  return {
    name: presetName,
    mainModel: readOptionalTrimmedString(record.mainModel, `modelPresets.${presetName}.mainModel`),
    subagentModels: readSubagentModels(record.subagentModels, presetName),
  };
}

export function createSyntheticDefaultModelPreset(): BrewvaModelPreset {
  return {
    name: DEFAULT_MODEL_PRESET_NAME,
    subagentModels: {},
    synthetic: true,
  };
}

export function cloneModelPreset(preset: BrewvaModelPreset): BrewvaModelPreset {
  return {
    name: preset.name,
    mainModel: preset.mainModel,
    subagentModels: { ...preset.subagentModels },
    synthetic: preset.synthetic,
  };
}

export function normalizeHostedModelPresetState(
  settings: HostedModelPresetSettingsShape,
): BrewvaModelPresetState {
  const authored = new Map<string, BrewvaModelPreset>();
  const rawPresets = settings.modelPresets;
  if (
    rawPresets !== undefined &&
    (!rawPresets || typeof rawPresets !== "object" || Array.isArray(rawPresets))
  ) {
    throw new Error("modelPresets must be an object");
  }
  for (const [name, value] of Object.entries(rawPresets ?? {})) {
    const preset = readPreset(name, value);
    if (preset) {
      if (authored.has(preset.name)) {
        throw new Error(`Duplicate model preset: ${preset.name}`);
      }
      authored.set(preset.name, preset);
    }
  }

  const defaultPreset =
    authored.get(DEFAULT_MODEL_PRESET_NAME) ?? createSyntheticDefaultModelPreset();

  const presets = [
    defaultPreset,
    ...[...authored.values()].filter((preset) => preset.name !== DEFAULT_MODEL_PRESET_NAME),
  ];
  const defaultName = readOptionalTrimmedString(settings.defaultModelPreset, "defaultModelPreset");
  if (defaultName && !presets.some((preset) => preset.name === defaultName)) {
    throw new Error(`Unknown default model preset: ${defaultName}`);
  }
  const resolvedDefaultName =
    defaultName && presets.some((preset) => preset.name === defaultName)
      ? defaultName
      : DEFAULT_MODEL_PRESET_NAME;

  return {
    activeName: resolvedDefaultName,
    defaultName: resolvedDefaultName,
    presets,
  };
}

export function cloneModelPresetState(state: BrewvaModelPresetState): BrewvaModelPresetState {
  return {
    activeName: state.activeName,
    defaultName: state.defaultName,
    pendingName: state.pendingName,
    presets: state.presets.map((preset) => cloneModelPreset(preset)),
  };
}

export function findModelPreset(
  state: Pick<BrewvaModelPresetState, "activeName" | "presets">,
  name = state.activeName,
): BrewvaModelPreset | undefined {
  return state.presets.find((preset) => preset.name === name);
}

export function selectNextModelPresetName(state: BrewvaModelPresetState): string {
  if (state.presets.length <= 1) {
    return state.activeName;
  }
  const currentName = state.pendingName ?? state.activeName;
  const currentIndex = state.presets.findIndex((preset) => preset.name === currentName);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % state.presets.length;
  return state.presets[nextIndex]?.name ?? state.activeName;
}
