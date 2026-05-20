import type { CredentialVaultService } from "@brewva/brewva-runtime/security";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type { ProviderCatalogOperations } from "./catalog.js";
import {
  PROVIDER_DESCRIPTIONS,
  consolidateConnectionProviders,
  formatProviderName,
  getProviderCredentialRef,
  groupModelsByProvider,
  listAvailableModels,
  resolveConnectionSource,
  resolveProviderGroup,
  sortProviders,
  type ProviderConnectionAuthStore,
  type ProviderConnectionModelCatalog,
} from "./shared.js";

export function createProviderCatalogOperations(input: {
  vault: CredentialVaultService;
  authStore?: ProviderConnectionAuthStore;
  modelRegistry: ProviderConnectionModelCatalog;
}): ProviderCatalogOperations {
  return {
    async listProviders() {
      const allModels = input.modelRegistry.getAll?.() ?? [];
      const availableModels = await listAvailableModels(input.modelRegistry);
      const availableByProvider = groupModelsByProvider(availableModels as BrewvaRegisteredModel[]);
      const providers = [...groupModelsByProvider(allModels as BrewvaRegisteredModel[]).entries()]
        .map(([provider, models]) => {
          const availableModelCount = availableByProvider.get(provider)?.length ?? 0;
          const connected =
            availableModelCount > 0 ||
            models.some((model) => input.modelRegistry.hasConfiguredAuth?.(model));
          return {
            id: provider,
            name: formatProviderName(provider),
            group: resolveProviderGroup(provider),
            connected,
            description: PROVIDER_DESCRIPTIONS[provider],
            connectionSource: resolveConnectionSource({
              vault: input.vault,
              authStore: input.authStore,
              provider,
              connected,
            }),
            modelProviders: [provider],
            modelCount: models.length,
            availableModelCount,
            credentialRef: getProviderCredentialRef(provider),
          };
        })
        .toSorted(sortProviders);
      return consolidateConnectionProviders(providers);
    },
  };
}
