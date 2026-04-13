import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
