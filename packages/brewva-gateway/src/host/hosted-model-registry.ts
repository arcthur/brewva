import { existsSync, readFileSync } from "node:fs";
import type { BrewvaProviderRegistration, BrewvaRegisteredModel } from "@brewva/brewva-substrate";
import { HostedAuthStore } from "./hosted-auth-store.js";
import { resolveHostedConfigValueOrThrow, resolveHostedHeaders } from "./hosted-config-value.js";
import { getHostedBuiltInModels, getHostedBuiltInProviders } from "./hosted-provider-helpers.js";
import type {
  HostedSessionBackendModelRegistry,
  HostedSessionModelServices,
} from "./hosted-session-backend-contract.js";

interface HostedProviderConfig extends BrewvaProviderRegistration {
  api?: string;
  compat?: BrewvaRegisteredModel["compat"];
  modelOverrides?: Record<
    string,
    Partial<Omit<BrewvaRegisteredModel, "provider" | "id">> & {
      api?: BrewvaRegisteredModel["api"];
      baseUrl?: string;
    }
  >;
}

interface HostedModelsFile {
  providers?: Record<string, HostedProviderConfig>;
}

interface ProviderRequestConfig {
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

type HostedModelOverride = NonNullable<HostedProviderConfig["modelOverrides"]>[string];

function cloneCompat(compat: BrewvaRegisteredModel["compat"]): BrewvaRegisteredModel["compat"] {
  if (!compat || typeof compat !== "object") {
    return compat;
  }

  return {
    ...compat,
    openRouterRouting:
      "openRouterRouting" in compat && compat.openRouterRouting
        ? { ...compat.openRouterRouting }
        : undefined,
    vercelGatewayRouting:
      "vercelGatewayRouting" in compat && compat.vercelGatewayRouting
        ? { ...compat.vercelGatewayRouting }
        : undefined,
  };
}

function cloneModel(model: BrewvaRegisteredModel): BrewvaRegisteredModel {
  return {
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
    headers: model.headers ? { ...model.headers } : undefined,
    compat: cloneCompat(model.compat),
    displayName: model.displayName,
  };
}

function mergeCompat(
  base: BrewvaRegisteredModel["compat"],
  override: BrewvaRegisteredModel["compat"],
): BrewvaRegisteredModel["compat"] {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
    openRouterRouting:
      "openRouterRouting" in (base ?? {}) || "openRouterRouting" in (override ?? {})
        ? {
            ...(typeof base === "object" && base && "openRouterRouting" in base
              ? base.openRouterRouting
              : undefined),
            ...(typeof override === "object" && override && "openRouterRouting" in override
              ? override.openRouterRouting
              : undefined),
          }
        : undefined,
    vercelGatewayRouting:
      "vercelGatewayRouting" in (base ?? {}) || "vercelGatewayRouting" in (override ?? {})
        ? {
            ...(typeof base === "object" && base && "vercelGatewayRouting" in base
              ? base.vercelGatewayRouting
              : undefined),
            ...(typeof override === "object" && override && "vercelGatewayRouting" in override
              ? override.vercelGatewayRouting
              : undefined),
          }
        : undefined,
  };
}

function getModelRequestKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

function applyModelOverride(
  model: BrewvaRegisteredModel,
  override: HostedModelOverride,
): BrewvaRegisteredModel {
  const next = cloneModel(model);
  if (override.name !== undefined) next.name = override.name;
  if (override.api !== undefined) next.api = override.api;
  if (override.baseUrl !== undefined) next.baseUrl = override.baseUrl;
  if (override.reasoning !== undefined) next.reasoning = override.reasoning;
  if (override.input !== undefined) next.input = [...override.input];
  if (override.cost) {
    next.cost = {
      input: override.cost.input ?? next.cost.input,
      output: override.cost.output ?? next.cost.output,
      cacheRead: override.cost.cacheRead ?? next.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? next.cost.cacheWrite,
    };
  }
  if (override.contextWindow !== undefined) next.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) next.maxTokens = override.maxTokens;
  next.compat = mergeCompat(next.compat, override.compat);
  if (override.displayName !== undefined) next.displayName = override.displayName;
  return next;
}

function readModelsFile(modelsJsonPath: string | undefined): HostedModelsFile {
  if (!modelsJsonPath || !existsSync(modelsJsonPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(modelsJsonPath, "utf8")) as HostedModelsFile;
  } catch {
    return {};
  }
}

export class HostedModelRegistry implements HostedSessionBackendModelRegistry {
  readonly #authStore: HostedAuthStore;
  readonly #modelsJsonPath: string | undefined;
  #models: BrewvaRegisteredModel[] = [];
  readonly #providerRequestConfigs = new Map<string, ProviderRequestConfig>();
  readonly #modelRequestHeaders = new Map<string, Record<string, string>>();
  readonly #registeredProviders = new Map<string, HostedProviderConfig>();

  private constructor(authStore: HostedAuthStore, modelsJsonPath?: string) {
    this.#authStore = authStore;
    this.#modelsJsonPath = modelsJsonPath;
    this.refresh();
  }

  static create(authStore: HostedAuthStore, modelsJsonPath: string): HostedModelRegistry {
    return new HostedModelRegistry(authStore, modelsJsonPath);
  }

  static inMemory(authStore: HostedAuthStore): HostedModelRegistry {
    return new HostedModelRegistry(authStore);
  }

  refresh(): void {
    this.#providerRequestConfigs.clear();
    this.#modelRequestHeaders.clear();
    this.#models = [];

    for (const provider of getHostedBuiltInProviders()) {
      this.#models.push(...getHostedBuiltInModels(provider));
    }

    const config = readModelsFile(this.#modelsJsonPath);
    for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
      this.applyProviderConfig(providerName, providerConfig);
    }
    for (const [providerName, providerConfig] of this.#registeredProviders) {
      this.applyProviderConfig(providerName, providerConfig);
    }
  }

  getAll(): BrewvaRegisteredModel[] {
    return this.#models.map((model) => cloneModel(model));
  }

  getAvailable(): BrewvaRegisteredModel[] {
    return this.getAll().filter((model) => this.hasConfiguredAuth(model));
  }

  find(provider: string, modelId: string): BrewvaRegisteredModel | undefined {
    const found = this.#models.find((model) => model.provider === provider && model.id === modelId);
    return found ? cloneModel(found) : undefined;
  }

  hasConfiguredAuth(model: BrewvaRegisteredModel): boolean {
    return (
      this.#authStore.hasAuth(model.provider) ||
      this.#providerRequestConfigs.get(model.provider)?.apiKey !== undefined
    );
  }

  async getApiKeyAndHeaders(
    model: BrewvaRegisteredModel,
  ): Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  > {
    try {
      const providerConfig = this.#providerRequestConfigs.get(model.provider);
      const apiKey =
        (await this.#authStore.getApiKey(model.provider, { includeFallback: false })) ??
        (providerConfig?.apiKey
          ? resolveHostedConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);
      const providerHeaders = resolveHostedHeaders(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHostedHeaders(
        this.#modelRequestHeaders.get(getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );
      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = {
          ...headers,
          Authorization: `Bearer ${apiKey}`,
        };
      }

      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  registerProvider(providerName: string, config: object): void {
    this.#registeredProviders.set(providerName, config as HostedProviderConfig);
    this.refresh();
  }

  unregisterProvider(providerName: string): void {
    if (!this.#registeredProviders.has(providerName)) {
      return;
    }
    this.#registeredProviders.delete(providerName);
    this.refresh();
  }

  isUsingOAuth(model: BrewvaRegisteredModel): boolean {
    return this.#authStore.get(model.provider)?.type === "oauth";
  }

  private applyProviderConfig(providerName: string, config: HostedProviderConfig): void {
    this.storeProviderRequestConfig(providerName, config);

    if (config.models && config.models.length > 0) {
      this.#models = this.#models.filter((model) => model.provider !== providerName);
      for (const modelDef of config.models) {
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
        this.#models.push({
          provider: providerName,
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: modelDef.api ?? config.api ?? "openai-completions",
          baseUrl: modelDef.baseUrl ?? config.baseUrl ?? "",
          reasoning: modelDef.reasoning,
          input: [...modelDef.input],
          cost: { ...modelDef.cost },
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers: undefined,
          compat: mergeCompat(config.compat, modelDef.compat),
          displayName: modelDef.displayName,
        });
      }
      return;
    }

    if (config.baseUrl || config.compat) {
      this.#models = this.#models.map((model) =>
        model.provider === providerName
          ? {
              ...model,
              baseUrl: config.baseUrl ?? model.baseUrl,
              compat: mergeCompat(model.compat, config.compat),
            }
          : model,
      );
    }

    for (const [modelId, override] of Object.entries(config.modelOverrides ?? {})) {
      this.storeModelHeaders(providerName, modelId, override.headers);
      this.#models = this.#models.map((model) =>
        model.provider === providerName && model.id === modelId
          ? applyModelOverride(model, override)
          : model,
      );
    }
  }

  private storeProviderRequestConfig(providerName: string, config: HostedProviderConfig): void {
    if (!config.apiKey && !config.headers && !config.authHeader) {
      return;
    }
    this.#providerRequestConfigs.set(providerName, {
      apiKey: config.apiKey,
      headers: config.headers,
      authHeader: config.authHeader,
    });
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers: Record<string, string> | undefined,
  ): void {
    const key = getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.#modelRequestHeaders.delete(key);
      return;
    }
    this.#modelRequestHeaders.set(key, { ...headers });
  }
}

export function createHostedModelServices(agentDir: string): HostedSessionModelServices {
  const authStore = HostedAuthStore.create(`${agentDir}/auth.json`);
  const modelRegistry = HostedModelRegistry.create(authStore, `${agentDir}/models.json`);
  return {
    authStore: {
      getApiKey: (provider) => authStore.getApiKey(provider, { includeFallback: false }),
      hasAuth: (provider) => authStore.hasAuth(provider),
      isUsingOAuth: (provider) => authStore.get(provider)?.type === "oauth",
    },
    modelRegistry,
  };
}
