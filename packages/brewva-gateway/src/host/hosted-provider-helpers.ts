import {
  getModels,
  getProviders,
  supportsXhighModelId,
} from "@brewva/brewva-provider-core/catalog";
import type {
  Api as ProviderCoreApi,
  Model as ProviderCoreModel,
} from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";

type ProviderCoreKnownProvider = ReturnType<typeof getProviders>[number];

function cloneCompat(
  compat: ProviderCoreModel<ProviderCoreApi>["compat"],
): BrewvaRegisteredModel["compat"] {
  if (!compat) {
    return undefined;
  }

  const nextCompat = { ...compat } as BrewvaRegisteredModel["compat"] & {
    openRouterRouting?: Record<string, unknown>;
  };
  if ("openRouterRouting" in nextCompat && nextCompat.openRouterRouting) {
    nextCompat.openRouterRouting = { ...nextCompat.openRouterRouting };
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

  return getModels(provider).map((model: ProviderCoreModel<ProviderCoreApi>) =>
    cloneBuiltInModel(model),
  );
}

export function supportsHostedExtendedThinkingModel(
  model: { id: string } | null | undefined,
): boolean {
  if (!model) {
    return false;
  }

  return supportsXhighModelId(model.id);
}
