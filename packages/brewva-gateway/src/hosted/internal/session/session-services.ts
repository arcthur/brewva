import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { InternalHostPlugin } from "@brewva/brewva-substrate/host-api";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type {
  BrewvaManagedPromptSession,
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferenceRef,
  BrewvaModelPreferences,
  BrewvaModelPresetState,
} from "@brewva/brewva-substrate/session";
import type {
  BrewvaManagedAgentSessionSettingsPort,
  ManagedAgentSessionStore,
} from "./managed-agent/session.js";
import type { HostedSessionUiOverrides } from "./session-factory.js";
import type { HostedAuthCredential } from "./settings/hosted-auth-store.js";

export type HostedSessionModelDescriptor = BrewvaRegisteredModel;

export interface HostedSessionSettingsStore extends BrewvaManagedAgentSessionSettingsPort {
  applyOverrides(overrides: HostedSessionUiOverrides): void;
  getImageAutoResize(): boolean;
  getQuietStartup(): boolean;
  reload(): Promise<void> | void;
  getBlockImages(): boolean;
  getDefaultThinkingLevel(): string | undefined;
  getModelPresetState(): BrewvaModelPresetState;
  getSelectedModelPreference(): BrewvaModelPreferenceRef | undefined;
  setSelectedModelPreference(model: BrewvaModelPreferenceRef | undefined): void;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export type HostedSessionPersistenceStore = ManagedAgentSessionStore;

export type HostedSessionResourceLoader = BrewvaHostedResourceLoader;

export type HostedSessionCreateResult = {
  session: BrewvaManagedPromptSession;
  modelFallbackMessage?: string;
};

export interface HostedSessionAuthStore {
  get(provider: string): HostedAuthCredential | undefined;
  getApiKey(provider: string): Promise<string | undefined> | string | undefined;
  hasAuth(provider: string): boolean;
  isUsingOAuth(provider: string): boolean;
  set(provider: string, credential: HostedAuthCredential): void;
  remove(provider: string): void;
  setFallbackResolver?(resolver: (provider: string) => string | undefined): void;
}

export interface HostedSessionModelRegistry {
  getAll(): HostedSessionModelDescriptor[];
  getAvailable(): HostedSessionModelDescriptor[] | Promise<HostedSessionModelDescriptor[]>;
  find(provider: string, modelId: string): HostedSessionModelDescriptor | undefined;
  hasConfiguredAuth(model: HostedSessionModelDescriptor): boolean;
  getApiKeyAndHeaders(
    model: HostedSessionModelDescriptor,
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >;
  refresh?(): void;
  registerProvider(providerName: string, config: object): void;
  unregisterProvider(providerName: string): void;
  isUsingOAuth(model: HostedSessionModelDescriptor): boolean;
}

export type HostedSessionServicesBundle = {
  agentDir: string;
  cwd: string;
  runtime: BrewvaHostedRuntimePort;
  settingsManager: HostedSessionSettingsStore;
  resourceLoader: HostedSessionResourceLoader;
  sessionManager: HostedSessionPersistenceStore;
  extensions?: readonly InternalHostPlugin[];
};

export interface HostedSessionModelServices {
  authStore: HostedSessionAuthStore;
  modelRegistry: HostedSessionModelRegistry;
}
