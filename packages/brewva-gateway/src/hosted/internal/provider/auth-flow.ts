import type { ProviderAuthFlowPort } from "./connection-types.js";
import type { ProviderAuthMethod, ProviderOAuthAuthorization } from "./types.js";

export interface ProviderAuthFlowOperations {
  listAuthMethods(provider: string): ProviderAuthMethod[];
  authorizeOAuth(
    provider: string,
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthAuthorization | undefined>;
  completeOAuth(provider: string, methodId: string, code?: string): Promise<void>;
}

export function createProviderAuthFlowPort(
  operations: ProviderAuthFlowOperations,
): ProviderAuthFlowPort {
  return {
    listAuthMethods: (provider) => operations.listAuthMethods(provider),
    authorizeOAuth: (provider, methodId, inputs) =>
      operations.authorizeOAuth(provider, methodId, inputs),
    completeOAuth: (provider, methodId, code) => operations.completeOAuth(provider, methodId, code),
  };
}
