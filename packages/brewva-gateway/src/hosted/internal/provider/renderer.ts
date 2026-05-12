import type { ProviderRendererPort } from "./connection-types.js";
import type { ProviderAuthMethod } from "./types.js";

export interface ProviderRendererOperations {
  listAuthMethods(provider: string): ProviderAuthMethod[];
}

export function createProviderRendererPort(
  operations: ProviderRendererOperations,
): ProviderRendererPort {
  return {
    listAuthMethods: (provider) => operations.listAuthMethods(provider),
  };
}
