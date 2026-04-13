import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaHostPluginFactory,
  BrewvaHostedResourceLoader,
  BrewvaManagedPromptSession,
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate";
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
}

export type HostedSessionPersistenceBackend = ManagedAgentSessionStore;

export type HostedSessionResourceLoaderBackend = BrewvaHostedResourceLoader;

export type HostedSessionBackendCreateResult = {
  session: BrewvaManagedPromptSession;
  modelFallbackMessage?: string;
};

export interface HostedSessionBackendAuthStore {
  getApiKey(provider: string): Promise<string | undefined> | string | undefined;
  hasAuth(provider: string): boolean;
  isUsingOAuth(provider: string): boolean;
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
  registerProvider(providerName: string, config: object): void;
  unregisterProvider(providerName: string): void;
  isUsingOAuth(model: HostedSessionBackendModelDescriptor): boolean;
}

export type HostedSessionServicesBundle = {
  agentDir: string;
  cwd: string;
  settingsManager: HostedSessionSettingsBackend;
  resourceLoader: HostedSessionResourceLoaderBackend;
  sessionManager: HostedSessionPersistenceBackend;
  runtimePlugins?: readonly BrewvaHostPluginFactory[];
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
    runtimePlugins?: readonly import("@brewva/brewva-substrate").BrewvaHostPluginFactory[];
  }): Promise<HostedSessionServicesBundle>;
  createSessionResult(input: {
    services: HostedSessionServicesBundle;
    modelRegistry: HostedSessionBackendModelRegistry;
    modelCatalog: BrewvaMutableModelCatalog;
    options: CreateHostedManagedSessionOptions;
  }): Promise<HostedSessionBackendCreateResult>;
}
