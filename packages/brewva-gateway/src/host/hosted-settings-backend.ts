import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferences,
} from "@brewva/brewva-substrate";
import type { HostedSessionSettingsBackend } from "./hosted-session-backend-contract.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionSettings,
  HostedSessionUiOverrides,
} from "./hosted-session-driver.js";

const PROJECT_SETTINGS_DIR = ".pi";

type HostedThinkingLevel =
  | NonNullable<CreateHostedManagedSessionOptions["thinkingLevel"]>
  | undefined;

interface HostedSettingsData {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: HostedThinkingLevel;
  transport?: "sse" | "websocket";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  quietStartup?: boolean;
  images?: {
    autoResize?: boolean;
    blockImages?: boolean;
  };
  retry?: {
    maxDelayMs?: number;
  };
  thinkingBudgets?: {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  };
  modelPreferences?: {
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
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HostedSettingsData;
  } catch {
    return {};
  }
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
    thinkingBudgets: {
      ...base.thinkingBudgets,
      ...override.thinkingBudgets,
    },
    modelPreferences: {
      ...base.modelPreferences,
      ...override.modelPreferences,
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

const HOSTED_SETTINGS_BRIDGE = Symbol.for("brewva.hosted.settings-backend");

class BrewvaHostedSettingsHandle implements HostedSessionSettings, HostedSessionSettingsBackend {
  readonly view: HostedSessionSettings["view"];
  readonly #globalPath: string;
  readonly #projectPath: string;
  #globalSettings: HostedSettingsData = {};
  #projectSettings: HostedSettingsData = {};
  #overrides: HostedSessionUiOverrides = {};

  constructor(cwd: string, agentDir: string) {
    this.#globalPath = join(agentDir, "settings.json");
    this.#projectPath = join(cwd, PROJECT_SETTINGS_DIR, "settings.json");
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

  getDefaultProvider(): string | undefined {
    return this.settings.defaultProvider;
  }

  getDefaultModel(): string | undefined {
    return this.settings.defaultModel;
  }

  getDefaultThinkingLevel(): HostedThinkingLevel {
    return this.settings.defaultThinkingLevel;
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode ?? "one-at-a-time";
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode ?? "one-at-a-time";
  }

  getTransport(): "sse" | "websocket" {
    return this.settings.transport ?? "sse";
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

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.#globalSettings.defaultProvider = provider;
    this.#globalSettings.defaultModel = modelId;
    this.persistGlobalSettings();
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

  setModelPreferences(preferences: BrewvaModelPreferences): void {
    this.#globalSettings.modelPreferences = normalizeModelPreferences(preferences);
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
): HostedSessionSettingsBackend {
  const maybeBridge = settings as HostedSessionSettings & {
    [HOSTED_SETTINGS_BRIDGE]?: (() => HostedSessionSettingsBackend) | undefined;
  };
  const getter = maybeBridge[HOSTED_SETTINGS_BRIDGE];
  if (typeof getter !== "function") {
    throw new Error("Unsupported hosted session settings handle.");
  }
  return getter.call(maybeBridge);
}
