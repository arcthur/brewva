import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_PROVIDER_CACHE_POLICY } from "@brewva/brewva-provider-core/cache";
import type {
  ProviderCachePolicy,
  ProviderCachePolicyReason,
  ProviderCacheRetention,
  ProviderCacheWriteMode,
} from "@brewva/brewva-provider-core/contracts";
import type {
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferenceRef,
  BrewvaModelPreferences,
  BrewvaModelPresetState,
} from "@brewva/brewva-substrate/session";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionSettings,
  HostedSessionUiOverrides,
} from "../session-factory.js";
import type { HostedSessionSettingsStore } from "../session-services.js";
import {
  normalizeHostedModelPresetState,
  type HostedModelPresetSettingsShape,
} from "./model-presets.js";

const PROJECT_SETTINGS_PATH = [".brewva", "agent", "settings.json"] as const;

type HostedThinkingLevel =
  | NonNullable<CreateHostedManagedSessionOptions["thinkingLevel"]>
  | undefined;

interface HostedSettingsData {
  defaultThinkingLevel?: HostedThinkingLevel;
  defaultModelPreset?: unknown;
  modelPresets?: Record<string, unknown>;
  transport?: "sse" | "websocket";
  queueMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  quietStartup?: boolean;
  images?: {
    autoResize?: boolean;
    blockImages?: boolean;
  };
  retry?: {
    maxDelayMs?: number;
  };
  cachePolicy?: {
    retention?: unknown;
    writeMode?: unknown;
    reason?: unknown;
  };
  thinkingBudgets?: {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  };
  modelPreferences?: {
    selected?: { provider?: unknown; id?: unknown };
    recent?: Array<{ provider?: unknown; id?: unknown }>;
    favorite?: Array<{ provider?: unknown; id?: unknown }>;
  };
  diffPreferences?: {
    style?: unknown;
    wrapMode?: unknown;
  };
  shellViewPreferences?: {
    showThinking?: unknown;
    toolDetails?: unknown;
  };
}

function readSettingsFile(path: string): HostedSettingsData {
  if (!existsSync(path)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
  rejectRemovedModelDefaultSettings(path, parsed);
  return parsed as HostedSettingsData;
}

function rejectRemovedModelDefaultSettings(path: string, parsed: unknown): void {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  const record = parsed as Record<string, unknown>;
  const removedKeys = ["defaultProvider", "defaultModel"].filter((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
  if (removedKeys.length === 0) {
    return;
  }
  throw new Error(
    `Removed hosted model default settings in ${path}: ${removedKeys.join(
      ", ",
    )}. Use modelPresets and defaultModelPreset instead.`,
  );
}

function mergeSettings(base: HostedSettingsData, override: HostedSettingsData): HostedSettingsData {
  return {
    ...base,
    ...override,
    images: {
      ...base.images,
      ...override.images,
    },
    retry: {
      ...base.retry,
      ...override.retry,
    },
    cachePolicy: {
      ...base.cachePolicy,
      ...override.cachePolicy,
    },
    thinkingBudgets: {
      ...base.thinkingBudgets,
      ...override.thinkingBudgets,
    },
    modelPreferences: {
      ...base.modelPreferences,
      ...override.modelPreferences,
    },
    modelPresets: {
      ...base.modelPresets,
      ...override.modelPresets,
    },
    diffPreferences: {
      ...base.diffPreferences,
      ...override.diffPreferences,
    },
    shellViewPreferences: {
      ...base.shellViewPreferences,
      ...override.shellViewPreferences,
    },
  };
}

function readModelPreferenceRef(value: unknown): { provider: string; id: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id = typeof record.id === "string" ? record.id.trim() : "";
  return provider && id ? { provider, id } : undefined;
}

function normalizeModelPreferenceList(
  values: readonly unknown[] | undefined,
  limit?: number,
): Array<{ provider: string; id: string }> {
  const entries: Array<{ provider: string; id: string }> = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const ref = readModelPreferenceRef(value);
    if (!ref) {
      continue;
    }
    const key = `${ref.provider}/${ref.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(ref);
    if (limit && entries.length >= limit) {
      break;
    }
  }
  return entries;
}

function normalizeModelPreferences(preferences: BrewvaModelPreferences): BrewvaModelPreferences {
  return {
    recent: normalizeModelPreferenceList(preferences.recent, 10),
    favorite: normalizeModelPreferenceList(preferences.favorite),
  };
}

function normalizeDiffPreferences(preferences: {
  style?: unknown;
  wrapMode?: unknown;
}): BrewvaDiffPreferences {
  return {
    style: preferences.style === "stacked" ? "stacked" : "auto",
    wrapMode: preferences.wrapMode === "none" ? "none" : "word",
  };
}

function normalizeShellViewPreferences(preferences: {
  showThinking?: unknown;
  toolDetails?: unknown;
}): BrewvaShellViewPreferences {
  return {
    showThinking: preferences.showThinking !== false,
    toolDetails: preferences.toolDetails !== false,
  };
}

function normalizeCacheRetention(value: unknown): ProviderCacheRetention {
  return value === "none" || value === "short" || value === "long"
    ? value
    : DEFAULT_PROVIDER_CACHE_POLICY.retention;
}

function normalizeCacheWriteMode(value: unknown): ProviderCacheWriteMode {
  return value === "readOnly" || value === "readWrite"
    ? value
    : DEFAULT_PROVIDER_CACHE_POLICY.writeMode;
}

function normalizeCacheReason(value: unknown): ProviderCachePolicyReason {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : DEFAULT_PROVIDER_CACHE_POLICY.reason;
}

const HOSTED_SETTINGS_BRIDGE = Symbol.for("brewva.hosted.settings-store");

class BrewvaHostedSettingsHandle implements HostedSessionSettings, HostedSessionSettingsStore {
  readonly view: HostedSessionSettings["view"];
  readonly #globalPath: string;
  readonly #projectPath: string;
  #globalSettings: HostedSettingsData = {};
  #projectSettings: HostedSettingsData = {};
  #overrides: HostedSessionUiOverrides = {};

  constructor(cwd: string, agentDir: string) {
    this.#globalPath = join(agentDir, "settings.json");
    this.#projectPath = join(cwd, ...PROJECT_SETTINGS_PATH);
    this.reload();
    this.view = {
      applyOverrides: (overrides) => {
        this.applyOverrides(overrides);
      },
      getImageAutoResize: () => this.getImageAutoResize(),
      getQuietStartup: () => this.getQuietStartup(),
    };
  }

  [HOSTED_SETTINGS_BRIDGE](): BrewvaHostedSettingsHandle {
    return this;
  }

  reload(): void {
    this.#globalSettings = readSettingsFile(this.#globalPath);
    this.#projectSettings = readSettingsFile(this.#projectPath);
  }

  async flush(): Promise<void> {
    return;
  }

  applyOverrides(overrides: HostedSessionUiOverrides): void {
    this.#overrides = { ...this.#overrides, ...overrides };
  }

  getImageAutoResize(): boolean {
    return this.#overrides.imageAutoResize ?? this.settings.images?.autoResize ?? true;
  }

  getQuietStartup(): boolean {
    return this.#overrides.quietStartup ?? this.settings.quietStartup ?? false;
  }

  getBlockImages(): boolean {
    return this.settings.images?.blockImages ?? false;
  }

  getDefaultThinkingLevel(): HostedThinkingLevel {
    return this.settings.defaultThinkingLevel;
  }

  getModelPresetState(): BrewvaModelPresetState {
    return normalizeHostedModelPresetState(this.settings as HostedModelPresetSettingsShape);
  }

  getQueueMode(): "all" | "one-at-a-time" {
    return this.settings.queueMode ?? "one-at-a-time";
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode ?? "one-at-a-time";
  }

  getTransport(): "sse" | "websocket" {
    return this.settings.transport ?? "sse";
  }

  getCachePolicy(): ProviderCachePolicy {
    const settings = this.settings.cachePolicy;
    return {
      retention: normalizeCacheRetention(settings?.retention),
      writeMode: normalizeCacheWriteMode(settings?.writeMode),
      scope: "session",
      reason: normalizeCacheReason(settings?.reason),
    };
  }

  getThinkingBudgets():
    | {
        minimal?: number;
        low?: number;
        medium?: number;
        high?: number;
      }
    | undefined {
    return this.settings.thinkingBudgets;
  }

  getRetrySettings(): { maxDelayMs: number } {
    return {
      maxDelayMs: this.settings.retry?.maxDelayMs ?? 60_000,
    };
  }

  setDefaultThinkingLevel(thinkingLevel: string): void {
    this.#globalSettings.defaultThinkingLevel = thinkingLevel as HostedThinkingLevel;
    this.persistGlobalSettings();
  }

  getModelPreferences(): BrewvaModelPreferences {
    const settings = this.settings.modelPreferences;
    return {
      recent: normalizeModelPreferenceList(settings?.recent, 10),
      favorite: normalizeModelPreferenceList(settings?.favorite),
    };
  }

  getSelectedModelPreference(): BrewvaModelPreferenceRef | undefined {
    return readModelPreferenceRef(this.settings.modelPreferences?.selected);
  }

  setSelectedModelPreference(model: BrewvaModelPreferenceRef | undefined): void {
    const preferences = this.#globalSettings.modelPreferences ?? {};
    const selected = readModelPreferenceRef(model);
    this.#globalSettings.modelPreferences = {
      recent: normalizeModelPreferenceList(preferences.recent, 10),
      favorite: normalizeModelPreferenceList(preferences.favorite),
      ...(selected ? { selected } : {}),
    };
    this.persistGlobalSettings();
  }

  setModelPreferences(preferences: BrewvaModelPreferences): void {
    const normalized = normalizeModelPreferences(preferences);
    const selected = readModelPreferenceRef(this.#globalSettings.modelPreferences?.selected);
    this.#globalSettings.modelPreferences = {
      ...(selected ? { selected } : {}),
      recent: normalized.recent,
      favorite: normalized.favorite,
    };
    this.persistGlobalSettings();
  }

  getDiffPreferences(): BrewvaDiffPreferences {
    return normalizeDiffPreferences(this.settings.diffPreferences ?? {});
  }

  setDiffPreferences(preferences: BrewvaDiffPreferences): void {
    this.#globalSettings.diffPreferences = normalizeDiffPreferences(preferences);
    this.persistGlobalSettings();
  }

  getShellViewPreferences(): BrewvaShellViewPreferences {
    return normalizeShellViewPreferences(this.settings.shellViewPreferences ?? {});
  }

  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void {
    this.#globalSettings.shellViewPreferences = normalizeShellViewPreferences(preferences);
    this.persistGlobalSettings();
  }

  private get settings(): HostedSettingsData {
    return mergeSettings(this.#globalSettings, this.#projectSettings);
  }

  private persistGlobalSettings(): void {
    mkdirSync(dirname(this.#globalPath), { recursive: true });
    writeFileSync(this.#globalPath, JSON.stringify(this.#globalSettings, null, 2), "utf8");
  }
}

export function createHostedSettingsHandle(cwd: string, agentDir: string): HostedSessionSettings {
  return new BrewvaHostedSettingsHandle(cwd, agentDir);
}

export function readHostedSettingsHandle(
  settings: HostedSessionSettings,
): HostedSessionSettingsStore {
  const maybeBridge = settings as HostedSessionSettings & {
    [HOSTED_SETTINGS_BRIDGE]?: (() => HostedSessionSettingsStore) | undefined;
  };
  const getter = maybeBridge[HOSTED_SETTINGS_BRIDGE];
  if (typeof getter !== "function") {
    throw new Error("Unsupported hosted session settings handle.");
  }
  return getter.call(maybeBridge);
}
