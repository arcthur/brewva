import { existsSync } from "node:fs";
import {
  getEnvApiKey,
  getModels,
  getProviders,
  supportsXhighModelId,
  type Api as ProviderCoreApi,
  type Model as ProviderCoreModel,
} from "@brewva/brewva-provider-core";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate";

interface HostedEnvLookupOptions {
  hasVertexAdcCredentials?: () => boolean;
}

type ProviderCoreKnownProvider = ReturnType<typeof getProviders>[number];

function cloneCompat(
  compat: ProviderCoreModel<ProviderCoreApi>["compat"],
): BrewvaRegisteredModel["compat"] {
  if (!compat) {
    return undefined;
  }

  const nextCompat = { ...compat } as BrewvaRegisteredModel["compat"] & {
    openRouterRouting?: Record<string, unknown>;
    vercelGatewayRouting?: Record<string, unknown>;
  };
  if ("openRouterRouting" in nextCompat && nextCompat.openRouterRouting) {
    nextCompat.openRouterRouting = { ...nextCompat.openRouterRouting };
  }
  if ("vercelGatewayRouting" in nextCompat && nextCompat.vercelGatewayRouting) {
    nextCompat.vercelGatewayRouting = { ...nextCompat.vercelGatewayRouting };
  }
  return nextCompat;
}

function cloneBuiltInModel(model: ProviderCoreModel<ProviderCoreApi>): BrewvaRegisteredModel {
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
    compat: cloneCompat(model.compat),
  };
}

function hasHostedVertexAdcCredentials(): boolean {
  const applicationCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (applicationCredentialsPath) {
    return existsSync(applicationCredentialsPath);
  }

  const homeDir = process.env.HOME;
  if (!homeDir) {
    return false;
  }

  return existsSync(`${homeDir}/.config/gcloud/application_default_credentials.json`);
}

export function getHostedEnvApiKey(
  provider: string,
  env: Record<string, string | undefined> = process.env,
  options: HostedEnvLookupOptions = {},
): string | undefined {
  return getEnvApiKey(provider, env, {
    hasVertexAdcCredentials: options.hasVertexAdcCredentials ?? hasHostedVertexAdcCredentials,
  });
}

function isBuiltInProvider(provider: string): provider is ProviderCoreKnownProvider {
  return getProviders().includes(provider as ProviderCoreKnownProvider);
}

export function getHostedBuiltInProviders(): string[] {
  return [...getProviders()];
}

export function getHostedBuiltInModels(provider: string): BrewvaRegisteredModel[] {
  if (!isBuiltInProvider(provider)) {
    return [];
  }

  return getModels(provider).map((model) => cloneBuiltInModel(model));
}

export function supportsHostedExtendedThinkingModel(
  model: { id: string } | null | undefined,
): boolean {
  if (!model) {
    return false;
  }

  return supportsXhighModelId(model.id);
}
