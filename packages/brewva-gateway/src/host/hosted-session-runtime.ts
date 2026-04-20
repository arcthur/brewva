import type {
  BrewvaMutableModelCatalog,
  BrewvaProviderAuthStore,
  BrewvaProviderRegistration,
  BrewvaRegisteredModel,
  BrewvaResolvedRequestAuth,
} from "@brewva/brewva-substrate";
import { createInMemoryModelCatalog } from "@brewva/brewva-substrate";
import {
  createHostedSessionModelServices,
  createHostedSessionResult,
  createHostedSessionServicesBundle,
  createHostedSessionSettingsHandle,
  type HostedSessionBackendAuthStore,
  type HostedSessionBackendModelRegistry,
  type HostedSessionServicesBundle,
} from "./hosted-session-backend.js";
import type {
  CreateHostedManagedSessionOptions,
  CreateHostedSessionRuntimeOptions,
  HostedManagedSessionRuntimeResult,
  HostedSessionDriver,
  HostedSessionServiceDiagnostic,
  HostedSessionServices,
  HostedSessionSettings,
} from "./hosted-session-driver.js";

type HostedBackendModelRegistry = HostedSessionBackendModelRegistry;
type HostedBackendAuthStore = HostedSessionBackendAuthStore;
type HostedBackendRegisteredModel = NonNullable<
  ReturnType<HostedBackendModelRegistry["getAll"]>[number]
>;

function cloneCompat(model: HostedBackendRegisteredModel): BrewvaRegisteredModel["compat"] {
  if (!model.compat) {
    return undefined;
  }
  const compat = { ...model.compat } as BrewvaRegisteredModel["compat"] & {
    openRouterRouting?: Record<string, unknown>;
    vercelGatewayRouting?: Record<string, unknown>;
  };
  if ("openRouterRouting" in compat && compat.openRouterRouting) {
    compat.openRouterRouting = { ...compat.openRouterRouting };
  }
  if ("vercelGatewayRouting" in compat && compat.vercelGatewayRouting) {
    compat.vercelGatewayRouting = { ...compat.vercelGatewayRouting };
  }
  return compat;
}

function toBrewvaModel(model: HostedBackendRegisteredModel): BrewvaRegisteredModel {
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
  constructor(private readonly authStore: HostedBackendAuthStore) {}

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
    private readonly backendRegistry: HostedBackendModelRegistry,
  ) {
    this.catalog = createInMemoryModelCatalog({
      models,
      auth: authStore,
    });
  }

  private resolveBackendModel(
    model: BrewvaRegisteredModel,
  ): HostedBackendRegisteredModel | undefined {
    return this.backendRegistry.find(model.provider, model.id);
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
    const backendModel = this.resolveBackendModel(model);
    return backendModel
      ? this.backendRegistry.hasConfiguredAuth(backendModel)
      : this.catalog.hasConfiguredAuth(model);
  }

  async getApiKeyAndHeaders(model: BrewvaRegisteredModel): Promise<BrewvaResolvedRequestAuth> {
    const backendModel = this.resolveBackendModel(model);
    if (!backendModel) {
      return this.catalog.getApiKeyAndHeaders(model);
    }

    const resolved = await this.backendRegistry.getApiKeyAndHeaders(backendModel);
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
    this.backendRegistry.registerProvider(
      providerName,
      clonedConfig as Parameters<HostedBackendModelRegistry["registerProvider"]>[1],
    );
  }

  unregisterProvider(providerName: string): void {
    this.catalog.unregisterProvider(providerName);
    this.backendRegistry.unregisterProvider(providerName);
  }

  isUsingOAuth(model: BrewvaRegisteredModel): boolean {
    const backendModel = this.resolveBackendModel(model);
    return backendModel
      ? this.backendRegistry.isUsingOAuth(backendModel)
      : this.catalog.isUsingOAuth(model);
  }
}

type HostedSessionRuntimeBundle = {
  runtime: HostedSessionServicesBundle;
  authStore: HostedBackendAuthStore;
  modelRegistry: HostedBackendModelRegistry;
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
    createSession(options) {
      return createHostedManagedSession(services, options);
    },
  };
}

class HostedSessionRuntimeDriver implements HostedSessionDriver {
  readonly modelCatalog: BrewvaMutableModelCatalog;
  readonly #agentDir: string;
  readonly #authStore: HostedBackendAuthStore;
  readonly #sessionModelRegistry: HostedBackendModelRegistry;

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
      thinkingLevel: options.requestedThinkingLevel,
      customTools: options.customTools,
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
      "cwd" | "settings" | "runtime" | "internalRuntimePlugins" | "sessionId"
    >,
  ): Promise<HostedSessionServices> {
    const runtime = await createHostedSessionServicesBundle({
      agentDir: this.#agentDir,
      cwd: options.cwd,
      settings: options.settings,
      runtime: options.runtime,
      runtimePlugins: options.internalRuntimePlugins,
      sessionId: options.sessionId,
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

export function createHostedSessionRuntimeDriver(agentDir: string): HostedSessionDriver {
  const driver = new HostedSessionRuntimeDriver(agentDir);
  return {
    modelCatalog: driver.modelCatalog,
    createRuntime(options) {
      return driver.createRuntime(options);
    },
  };
}

export function createHostedSessionRuntimeSettings(
  cwd: string,
  agentDir: string,
): HostedSessionSettings {
  return createHostedSessionSettingsHandle(cwd, agentDir);
}
