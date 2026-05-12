import type { ProviderCatalogPort } from "./connection-types.js";
import type { ProviderConnectionDescriptor } from "./types.js";

export interface ProviderCatalogOperations {
  listProviders(): Promise<ProviderConnectionDescriptor[]>;
}

export function createProviderCatalogPort(
  operations: ProviderCatalogOperations,
): ProviderCatalogPort {
  return {
    listProviders: () => operations.listProviders(),
  };
}
