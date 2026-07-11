import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaModelPreset,
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
  BrewvaModelRoleMap,
} from "@brewva/brewva-substrate/session";

export const DEFAULT_MODEL_PRESET_NAME = "Default";

export const MODEL_ROLE_ALIASES = [
  "default",
  "smol",
  "slow",
  "plan",
  "commit",
  "task",
] as const satisfies readonly BrewvaModelRoleAlias[];

const MODEL_ROLE_ALIAS_SET = new Set<BrewvaModelRoleAlias>(MODEL_ROLE_ALIASES);

export function isBrewvaModelRoleAlias(value: string): value is BrewvaModelRoleAlias {
  return MODEL_ROLE_ALIAS_SET.has(value as BrewvaModelRoleAlias);
}

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

function readRoleModels(value: unknown, presetName: string): BrewvaModelRoleMap {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`modelPresets.${presetName}.roles must be an object`);
  }
  const models: BrewvaModelRoleMap = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawKey.trim().length === 0) {
      throw new Error(`modelPresets.${presetName}.roles keys must be non-empty`);
    }
    if (rawKey !== rawKey.trim()) {
      throw new Error(`modelPresets.${presetName}.roles keys must be trimmed`);
    }
    if (!MODEL_ROLE_ALIAS_SET.has(rawKey as BrewvaModelRoleAlias)) {
      throw new Error(`modelPresets.${presetName}.roles.${rawKey} must be a model role alias`);
    }
    models[rawKey as BrewvaModelRoleAlias] = readOptionalTrimmedString(
      rawValue,
      `modelPresets.${presetName}.roles.${rawKey}`,
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
  if (!isRecord(value)) {
    throw new Error(`modelPresets.${presetName} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const removedKeys = ["mainModel", "delegationModels", "auxiliaryModels", "subagentModels"].filter(
    (key) => record[key] !== undefined,
  );
  if (removedKeys.length > 0) {
    throw new Error(
      `modelPresets.${presetName} uses removed model preset fields: ${removedKeys.join(
        ", ",
      )}. Use roles keyed by model role alias.`,
    );
  }
  return {
    name: presetName,
    roles: readRoleModels(record.roles, presetName),
  };
}

export function createSyntheticDefaultModelPreset(): BrewvaModelPreset {
  return {
    name: DEFAULT_MODEL_PRESET_NAME,
    // Synthetic default intentionally leaves roles empty; startup falls back to the
    // session/operator selected model rather than inventing a hidden preset model.
    roles: {},
    synthetic: true,
  };
}

export function cloneModelPreset(preset: BrewvaModelPreset): BrewvaModelPreset {
  return {
    name: preset.name,
    roles: { ...preset.roles },
    synthetic: preset.synthetic,
  };
}

export function normalizeHostedModelPresetState(
  settings: HostedModelPresetSettingsShape,
): BrewvaModelPresetState {
  const authored = new Map<string, BrewvaModelPreset>();
  const rawPresets = settings.modelPresets;
  if (rawPresets !== undefined && !isRecord(rawPresets)) {
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

export function resolvePresetRoleModel(
  preset: BrewvaModelPreset | undefined,
  role: BrewvaModelRoleAlias,
): string | undefined {
  return preset?.roles[role] ?? (role === "default" ? undefined : preset?.roles.default);
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
