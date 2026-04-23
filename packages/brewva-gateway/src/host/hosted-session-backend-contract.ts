import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  InternalHostPlugin,
  BrewvaHostedResourceLoader,
  BrewvaManagedPromptSession,
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferences,
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate";
import type { HostedAuthCredential } from "./hosted-auth-store.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionSettings,
  HostedSessionUiOverrides,
} from "./hosted-session-driver.js";
import type {
  BrewvaManagedAgentSessionSettingsPort,
  ManagedAgentSessionStore,
} from "./managed-agent-session.js";

export type HostedSessionBackendModelDescriptor = BrewvaRegisteredModel;

export interface HostedSessionSettingsBackend extends BrewvaManagedAgentSessionSettingsPort {
  applyOverrides(overrides: HostedSessionUiOverrides): void;
  getImageAutoResize(): boolean;
  getQuietStartup(): boolean;
  reload(): Promise<void> | void;
  getBlockImages(): boolean;
  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): string | undefined;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export type HostedSessionPersistenceBackend = ManagedAgentSessionStore;

export type HostedSessionResourceLoaderBackend = BrewvaHostedResourceLoader;

export type HostedSessionBackendCreateResult = {
  session: BrewvaManagedPromptSession;
  modelFallbackMessage?: string;
};

export interface HostedSessionBackendAuthStore {
  get(provider: string): HostedAuthCredential | undefined;
  getApiKey(provider: string): Promise<string | undefined> | string | undefined;
  hasAuth(provider: string): boolean;
  isUsingOAuth(provider: string): boolean;
  set(provider: string, credential: HostedAuthCredential): void;
  remove(provider: string): void;
  setFallbackResolver?(resolver: (provider: string) => string | undefined): void;
}

export interface HostedSessionBackendModelRegistry {
  getAll(): HostedSessionBackendModelDescriptor[];
  getAvailable():
    | HostedSessionBackendModelDescriptor[]
    | Promise<HostedSessionBackendModelDescriptor[]>;
  find(provider: string, modelId: string): HostedSessionBackendModelDescriptor | undefined;
  hasConfiguredAuth(model: HostedSessionBackendModelDescriptor): boolean;
  getApiKeyAndHeaders(
    model: HostedSessionBackendModelDescriptor,
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >;
  refresh?(): void;
  registerProvider(providerName: string, config: object): void;
  unregisterProvider(providerName: string): void;
  isUsingOAuth(model: HostedSessionBackendModelDescriptor): boolean;
}

export type HostedSessionServicesBundle = {
  agentDir: string;
  cwd: string;
  runtime: BrewvaRuntime;
  settingsManager: HostedSessionSettingsBackend;
  resourceLoader: HostedSessionResourceLoaderBackend;
  sessionManager: HostedSessionPersistenceBackend;
  runtimePlugins?: readonly InternalHostPlugin[];
};

export interface HostedSessionModelServices {
  authStore: HostedSessionBackendAuthStore;
  modelRegistry: HostedSessionBackendModelRegistry;
}

export interface HostedSessionBackendAdapter {
  createSettingsHandle(cwd: string, agentDir: string): HostedSessionSettings;
  createModelServices(agentDir: string): HostedSessionModelServices;
  createServicesBundle(input: {
    agentDir: string;
    cwd: string;
    settings: HostedSessionSettings;
    runtime?: BrewvaRuntime;
    runtimePlugins?: readonly import("@brewva/brewva-substrate").InternalHostPlugin[];
    sessionId?: string;
  }): Promise<HostedSessionServicesBundle>;
  createSessionResult(input: {
    services: HostedSessionServicesBundle;
    modelRegistry: HostedSessionBackendModelRegistry;
    modelCatalog: BrewvaMutableModelCatalog;
    options: CreateHostedManagedSessionOptions;
  }): Promise<HostedSessionBackendCreateResult>;
}
