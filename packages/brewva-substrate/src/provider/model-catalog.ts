import type {
  BrewvaMutableModelCatalog,
  BrewvaProviderAuthStore,
  BrewvaProviderRegistration,
  BrewvaRegisteredModel,
  BrewvaResolvedRequestAuth,
} from "../contracts/provider.js";

export interface CreateInMemoryModelCatalogOptions {
  models?: readonly BrewvaRegisteredModel[];
  auth?: BrewvaProviderAuthStore;
}

interface ProviderRequestConfig {
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

function getModelRequestKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function cloneModel(model: BrewvaRegisteredModel): BrewvaRegisteredModel {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    headers: model.headers ? { ...model.headers } : undefined,
    compat: model.compat ? { ...model.compat } : undefined,
  };
}

function cloneModels(models: readonly BrewvaRegisteredModel[]): BrewvaRegisteredModel[] {
  return models.map((model) => cloneModel(model));
}

function mergeHeaders(
  left?: Record<string, string>,
  right?: Record<string, string>,
): Record<string, string> | undefined {
  if (!left && !right) {
    return undefined;
  }
  const merged = {
    ...left,
    ...right,
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

class InMemoryModelCatalog implements BrewvaMutableModelCatalog {
  private readonly baseModels: BrewvaRegisteredModel[];

  private readonly registrations = new Map<string, BrewvaProviderRegistration>();

  private readonly requestConfigs = new Map<string, ProviderRequestConfig>();

  private readonly modelRequestHeaders = new Map<string, Record<string, string>>();

  private models: BrewvaRegisteredModel[];

  constructor(
    options: CreateInMemoryModelCatalogOptions,
    private readonly auth: BrewvaProviderAuthStore,
  ) {
    this.baseModels = cloneModels(options.models ?? []);
    this.models = cloneModels(options.models ?? []);
  }

  getAll(): BrewvaRegisteredModel[] {
    return cloneModels(this.models);
  }

  getAvailable(): BrewvaRegisteredModel[] {
    return this.getAll().filter((model) => this.hasConfiguredAuth(model));
  }

  find(provider: string, modelId: string): BrewvaRegisteredModel | undefined {
    const found = this.models.find((model) => model.provider === provider && model.id === modelId);
    return found ? cloneModel(found) : undefined;
  }

  hasConfiguredAuth(model: BrewvaRegisteredModel): boolean {
    return (
      this.auth.hasAuth?.(model.provider) === true ||
      typeof this.requestConfigs.get(model.provider)?.apiKey === "string"
    );
  }

  async getApiKeyAndHeaders(model: BrewvaRegisteredModel): Promise<BrewvaResolvedRequestAuth> {
    const config = this.requestConfigs.get(model.provider);
    const modelHeaders = this.modelRequestHeaders.get(getModelRequestKey(model.provider, model.id));
    const storedApiKey = await this.auth.getApiKey(model.provider);
    const apiKey = storedApiKey ?? config?.apiKey;
    const headers = mergeHeaders(mergeHeaders(model.headers, config?.headers), modelHeaders);

    if (config?.authHeader) {
      if (!apiKey) {
        return {
          ok: false,
          error: `No API key found for "${model.provider}"`,
        };
      }
      return {
        ok: true,
        apiKey,
        headers: {
          ...headers,
          Authorization: `Bearer ${apiKey}`,
        },
      };
    }

    return {
      ok: true,
      apiKey,
      headers,
    };
  }

  isUsingOAuth(model: BrewvaRegisteredModel): boolean {
    return this.auth.isUsingOAuth?.(model.provider) === true;
  }

  registerProvider(providerName: string, config: BrewvaProviderRegistration): void {
    this.registrations.set(providerName, {
      ...config,
      headers: config.headers ? { ...config.headers } : undefined,
      models: config.models?.map((model) => ({
        ...model,
        input: [...model.input],
        cost: { ...model.cost },
        headers: model.headers ? { ...model.headers } : undefined,
        compat: model.compat ? { ...model.compat } : undefined,
      })),
    });
    this.refresh();
  }

  unregisterProvider(providerName: string): void {
    if (!this.registrations.delete(providerName)) {
      return;
    }
    this.refresh();
  }

  private refresh(): void {
    this.models = cloneModels(this.baseModels);
    this.requestConfigs.clear();
    this.modelRequestHeaders.clear();

    for (const [providerName, registration] of this.registrations.entries()) {
      this.requestConfigs.set(providerName, {
        apiKey: registration.apiKey,
        headers: registration.headers ? { ...registration.headers } : undefined,
        authHeader: registration.authHeader,
      });

      if (registration.models && registration.models.length > 0) {
        this.models = this.models.filter((model) => model.provider !== providerName);
        for (const definition of registration.models) {
          if (definition.headers && Object.keys(definition.headers).length > 0) {
            this.modelRequestHeaders.set(getModelRequestKey(providerName, definition.id), {
              ...definition.headers,
            });
          }
          this.models.push({
            provider: providerName,
            id: definition.id,
            name: definition.name,
            api: definition.api,
            baseUrl: registration.baseUrl ?? definition.baseUrl ?? "",
            reasoning: definition.reasoning,
            input: [...definition.input],
            cost: { ...definition.cost },
            contextWindow: definition.contextWindow,
            maxTokens: definition.maxTokens,
            headers: undefined,
            compat: definition.compat ? { ...definition.compat } : undefined,
            displayName: definition.displayName,
          });
        }
        continue;
      }

      if (registration.baseUrl || registration.headers) {
        this.models = this.models.map((model) => {
          if (model.provider !== providerName) {
            return model;
          }
          return {
            ...model,
            baseUrl: registration.baseUrl ?? model.baseUrl,
          };
        });
      }
    }
  }
}

export function createInMemoryModelCatalog(
  options: CreateInMemoryModelCatalogOptions = {},
): BrewvaMutableModelCatalog {
  return new InMemoryModelCatalog(
    options,
    options.auth ?? {
      async getApiKey() {
        return undefined;
      },
      hasAuth() {
        return false;
      },
      isUsingOAuth() {
        return false;
      },
    },
  );
}
