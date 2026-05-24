import type {
  BrewvaMutableModelCatalog,
  BrewvaProviderAuthStore,
  BrewvaProviderRegistration,
  BrewvaRegisteredModel,
  BrewvaResolvedRequestAuth,
} from "@brewva/brewva-substrate/provider";
import { createInMemoryModelCatalog } from "@brewva/brewva-substrate/provider";
import {
  configureCredentialVaultModelAuth,
  createProviderConnectionSeams,
  createProviderConnectionPort,
} from "../provider/connection-port.js";
import {
  createHostedSessionModelServices,
  createHostedSessionResult,
  createHostedSessionServicesBundle,
  createHostedSessionSettingsHandle,
  type HostedSessionAuthStore,
  type HostedSessionModelRegistry,
  type HostedSessionServicesBundle,
} from "./local-session-services.js";
import type {
  CreateHostedManagedSessionOptions,
  CreateHostedSessionRuntimeOptions,
  HostedManagedSessionRuntimeResult,
  HostedSessionFactory,
  HostedSessionServiceDiagnostic,
  HostedSessionServices,
  HostedSessionSettings,
} from "./session-factory.js";

type HostedModelRegistryPort = HostedSessionModelRegistry;
type HostedAuthStorePort = HostedSessionAuthStore;
type HostedRegisteredModel = NonNullable<ReturnType<HostedModelRegistryPort["getAll"]>[number]>;

function cloneCompat(model: HostedRegisteredModel): BrewvaRegisteredModel["compat"] {
  if (!model.compat) {
    return undefined;
  }
  const compat = { ...model.compat } as BrewvaRegisteredModel["compat"] & {
    openRouterRouting?: Record<string, unknown>;
  };
  if ("openRouterRouting" in compat && compat.openRouterRouting) {
    compat.openRouterRouting = { ...compat.openRouterRouting };
  }
  return compat;
}

function toBrewvaModel(model: HostedRegisteredModel): BrewvaRegisteredModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers ? { ...model.headers } : undefined,
    compat: cloneCompat(model),
    displayName:
      "displayName" in model && typeof model.displayName === "string"
        ? model.displayName
        : undefined,
  };
}

function cloneProviderRegistration(config: BrewvaProviderRegistration): BrewvaProviderRegistration {
  return {
    ...config,
    headers: config.headers ? { ...config.headers } : undefined,
    models: config.models?.map((model) => ({
      ...model,
      input: [...model.input],
      cost: { ...model.cost },
      headers: model.headers ? { ...model.headers } : undefined,
      compat: model.compat ? { ...model.compat } : undefined,
    })),
  };
}

class HostedAuthStoreAdapter implements BrewvaProviderAuthStore {
  constructor(private readonly authStore: HostedAuthStorePort) {}

  async getApiKey(provider: string): Promise<string | undefined> {
    return this.authStore.getApiKey(provider);
  }

  hasAuth(provider: string): boolean {
    return this.authStore.hasAuth(provider);
  }

  isUsingOAuth(provider: string): boolean {
    return this.authStore.isUsingOAuth(provider);
  }
}

class HostedModelCatalog implements BrewvaMutableModelCatalog {
  private readonly catalog: BrewvaMutableModelCatalog;

  constructor(
    models: readonly BrewvaRegisteredModel[],
    authStore: BrewvaProviderAuthStore,
    private readonly modelRegistry: HostedModelRegistryPort,
  ) {
    this.catalog = createInMemoryModelCatalog({
      models,
      auth: authStore,
    });
  }

  private resolveRegisteredModel(model: BrewvaRegisteredModel): HostedRegisteredModel | undefined {
    return this.modelRegistry.find(model.provider, model.id);
  }

  getAll(): BrewvaRegisteredModel[] {
    return this.catalog.getAll();
  }

  getAvailable(): BrewvaRegisteredModel[] | Promise<BrewvaRegisteredModel[]> {
    return this.catalog.getAll().filter((model) => this.hasConfiguredAuth(model));
  }

  find(provider: string, modelId: string): BrewvaRegisteredModel | undefined {
    return this.catalog.find(provider, modelId);
  }

  hasConfiguredAuth(model: BrewvaRegisteredModel): boolean {
    const registeredModel = this.resolveRegisteredModel(model);
    return registeredModel
      ? this.modelRegistry.hasConfiguredAuth(registeredModel)
      : this.catalog.hasConfiguredAuth(model);
  }

  async getApiKeyAndHeaders(model: BrewvaRegisteredModel): Promise<BrewvaResolvedRequestAuth> {
    const registeredModel = this.resolveRegisteredModel(model);
    if (!registeredModel) {
      return this.catalog.getApiKeyAndHeaders(model);
    }

    const resolved = await this.modelRegistry.getApiKeyAndHeaders(registeredModel);
    return resolved.ok
      ? {
          ok: true,
          apiKey: resolved.apiKey,
          headers: resolved.headers,
        }
      : {
          ok: false,
          error: resolved.error,
        };
  }

  registerProvider(providerName: string, config: BrewvaProviderRegistration): void {
    const clonedConfig = cloneProviderRegistration(config);
    this.catalog.registerProvider(providerName, clonedConfig);
    this.modelRegistry.registerProvider(
      providerName,
      clonedConfig as Parameters<HostedModelRegistryPort["registerProvider"]>[1],
    );
  }

  unregisterProvider(providerName: string): void {
    this.catalog.unregisterProvider(providerName);
    this.modelRegistry.unregisterProvider(providerName);
  }

  isUsingOAuth(model: BrewvaRegisteredModel): boolean {
    const registeredModel = this.resolveRegisteredModel(model);
    return registeredModel
      ? this.modelRegistry.isUsingOAuth(registeredModel)
      : this.catalog.isUsingOAuth(model);
  }
}

type HostedSessionRuntimeBundle = {
  runtime: HostedSessionServicesBundle;
  authStore: HostedAuthStorePort;
  modelRegistry: HostedModelRegistryPort;
  modelCatalog: BrewvaMutableModelCatalog;
  cwd: string;
  settings: HostedSessionSettings["view"];
  diagnostics?: readonly HostedSessionServiceDiagnostic[];
};

function createHostedManagedSession(
  services: HostedSessionRuntimeBundle,
  options: CreateHostedManagedSessionOptions,
): Promise<Pick<HostedManagedSessionRuntimeResult, "session" | "modelFallbackMessage">> {
  return createHostedSessionResult({
    services: services.runtime,
    modelRegistry: services.modelRegistry,
    modelCatalog: services.modelCatalog,
    options,
  });
}

function createHostedSessionServices(services: HostedSessionRuntimeBundle): HostedSessionServices {
  return {
    cwd: services.cwd,
    diagnostics: services.diagnostics ?? [],
    settings: services.settings,
    modelCatalog: services.modelCatalog,
    providerConnections: createProviderConnectionSeams(
      createProviderConnectionPort({
        runtime: services.runtime.runtime,
        modelRegistry: services.modelRegistry,
        authStore: services.authStore,
      }),
    ),
    createSession(options) {
      return createHostedManagedSession(services, options);
    },
  };
}

class HostedSessionRuntimeFactory implements HostedSessionFactory {
  readonly modelCatalog: BrewvaMutableModelCatalog;
  readonly #agentDir: string;
  readonly #authStore: HostedAuthStorePort;
  readonly #sessionModelRegistry: HostedModelRegistryPort;

  constructor(agentDir: string) {
    this.#agentDir = agentDir;
    const modelServices = createHostedSessionModelServices(agentDir);
    this.#authStore = modelServices.authStore;
    this.#sessionModelRegistry = modelServices.modelRegistry;
    this.modelCatalog = new HostedModelCatalog(
      this.#sessionModelRegistry.getAll().map((model) => toBrewvaModel(model)),
      new HostedAuthStoreAdapter(this.#authStore),
      this.#sessionModelRegistry,
    );
  }

  async createRuntime(
    options: CreateHostedSessionRuntimeOptions,
  ): Promise<HostedManagedSessionRuntimeResult> {
    const services = await this.createServices(options);
    const result = await services.createSession({
      model: options.requestedModel,
      modelRole: options.requestedModelRole,
      thinkingLevel: options.requestedThinkingLevel,
      customTools: options.customTools,
      deferPersistenceUntilPrompt: options.deferPersistenceUntilPrompt,
      onInitialPersistence: options.onInitialPersistence,
      ui: options.ui,
      logger: options.logger,
    });
    return {
      services,
      ...result,
    };
  }

  private async createServices(
    options: Pick<
      CreateHostedSessionRuntimeOptions,
      "cwd" | "settings" | "runtime" | "extensions" | "sessionId" | "deferPersistenceUntilPrompt"
    >,
  ): Promise<HostedSessionServices> {
    const runtime = await createHostedSessionServicesBundle({
      agentDir: this.#agentDir,
      cwd: options.cwd,
      settings: options.settings,
      runtime: options.runtime,
      extensions: options.extensions,
      sessionId: options.sessionId,
      deferPersistenceUntilPrompt: options.deferPersistenceUntilPrompt,
    });
    configureCredentialVaultModelAuth({
      runtime: runtime.runtime,
      authStore: this.#authStore,
    });
    return createHostedSessionServices({
      runtime,
      authStore: this.#authStore,
      modelRegistry: this.#sessionModelRegistry,
      modelCatalog: this.modelCatalog,
      cwd: options.cwd,
      settings: options.settings.view,
      diagnostics: [],
    });
  }
}

export function createHostedSessionRuntimeFactory(agentDir: string): HostedSessionFactory {
  const factory = new HostedSessionRuntimeFactory(agentDir);
  return {
    modelCatalog: factory.modelCatalog,
    createRuntime(options) {
      return factory.createRuntime(options);
    },
  };
}

export function createHostedSessionRuntimeSettings(
  cwd: string,
  agentDir: string,
): HostedSessionSettings {
  return createHostedSessionSettingsHandle(cwd, agentDir);
}
