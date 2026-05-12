import type { ProviderCredentialPort } from "./connection-types.js";
import type { ProviderConnectionDescriptor } from "./types.js";

export interface ProviderCredentialOperations {
  listProviders(): Promise<ProviderConnectionDescriptor[]>;
  connectApiKey(provider: string, key: string, inputs?: Record<string, string>): Promise<void>;
  disconnect(provider: string): Promise<void>;
  refresh(): Promise<void>;
}

export function createProviderCredentialPort(
  operations: ProviderCredentialOperations,
): ProviderCredentialPort {
  return {
    listProviders: () => operations.listProviders(),
    connectApiKey: (provider, key, inputs) => operations.connectApiKey(provider, key, inputs),
    disconnect: (provider) => operations.disconnect(provider),
    refresh: () => operations.refresh(),
  };
}
