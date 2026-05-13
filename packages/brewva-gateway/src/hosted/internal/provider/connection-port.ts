import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import {
  createCredentialVaultServiceFromSecurityConfig,
  type CredentialVaultService,
} from "@brewva/brewva-runtime/credentials";
import type { HostedAuthCredential } from "../session/settings/hosted-auth-store.js";
import { createProviderAuthFlowOperations } from "./auth-flow-operations.js";
import { createProviderAuthFlowPort } from "./auth-flow.js";
import { createProviderCatalogOperations } from "./catalog-operations.js";
import { createProviderCatalogPort } from "./catalog.js";
import type { ProviderConnectionSeams } from "./connection-types.js";
import type { ProviderConnectionPort } from "./connection-types.js";
import { createProviderCredentialOperations } from "./credential-operations.js";
import { createProviderCredentialPort } from "./credential.js";
import { createBuiltInProviderAuthHandlers } from "./oauth-handlers.js";
import { createProviderRendererPort } from "./renderer.js";
import {
  getProviderCredentialRef,
  type ProviderConnectionAuthStore,
  type ProviderConnectionModelCatalog,
} from "./shared.js";
import type { ProviderAuthHandler, ProviderOAuthCompletion } from "./types.js";

export { getProviderCredentialRef } from "./shared.js";

const pendingOAuthCompletions = new Map<
  string,
  Pick<ProviderOAuthCompletion, "complete"> & {
    credentialProvider: string;
    completionPromise?: Promise<HostedAuthCredential>;
    stored?: boolean;
  }
>();

function createVault(runtime: BrewvaRuntimeRoot): CredentialVaultService {
  return createCredentialVaultServiceFromSecurityConfig(
    runtime.identity.workspaceRoot,
    runtime.config.security as Parameters<typeof createCredentialVaultServiceFromSecurityConfig>[1],
  );
}

export function configureCredentialVaultModelAuth(input: {
  runtime: BrewvaRuntimeRoot;
  authStore: { setFallbackResolver?: (resolver: (provider: string) => string | undefined) => void };
}): void {
  const vault = createVault(input.runtime);
  input.authStore.setFallbackResolver?.((provider) => {
    try {
      return vault.get(getProviderCredentialRef(provider));
    } catch {
      return undefined;
    }
  });
}

export function createProviderConnectionPort(input: {
  runtime: BrewvaRuntimeRoot;
  modelRegistry: ProviderConnectionModelCatalog;
  authStore?: ProviderConnectionAuthStore;
  authHandlers?: readonly ProviderAuthHandler[];
}): ProviderConnectionPort {
  const vault = createVault(input.runtime);
  const authHandlers = [...createBuiltInProviderAuthHandlers(), ...(input.authHandlers ?? [])];
  const refresh = async () => {
    input.modelRegistry.refresh?.();
  };
  const catalogOperations = createProviderCatalogOperations({
    vault,
    authStore: input.authStore,
    modelRegistry: input.modelRegistry,
  });
  const authFlowOperations = createProviderAuthFlowOperations({
    vault,
    authStore: input.authStore,
    authHandlers,
    pendingOAuthCompletions,
    refresh,
  });
  const seams: ProviderConnectionSeams = {
    credential: createProviderCredentialPort(
      createProviderCredentialOperations({
        vault,
        authStore: input.authStore,
        listProviders: () => catalogOperations.listProviders(),
        refresh,
      }),
    ),
    authFlow: createProviderAuthFlowPort(authFlowOperations),
    catalog: createProviderCatalogPort(catalogOperations),
    renderer: createProviderRendererPort({
      listAuthMethods: (provider) => authFlowOperations.listAuthMethods(provider),
    }),
  };
  return createProviderConnectionPortFromSeams(seams);
}

export function createProviderConnectionSeams(
  operations: ProviderConnectionPort,
): ProviderConnectionSeams {
  return {
    credential: createProviderCredentialPort(operations),
    authFlow: createProviderAuthFlowPort(operations),
    catalog: createProviderCatalogPort(operations),
    renderer: createProviderRendererPort(operations),
  };
}

export function createProviderConnectionPortFromSeams(
  seams: ProviderConnectionSeams,
): ProviderConnectionPort {
  return {
    listProviders: async () => [...(await seams.catalog.listProviders())],
    listAuthMethods: (provider) => [...seams.renderer.listAuthMethods(provider)],
    connectApiKey: (provider, key, inputs) => seams.credential.connectApiKey(provider, key, inputs),
    authorizeOAuth: (provider, methodId, inputs) =>
      seams.authFlow.authorizeOAuth(provider, methodId, inputs),
    completeOAuth: (provider, methodId, code) =>
      seams.authFlow.completeOAuth(provider, methodId, code),
    disconnect: (provider) => seams.credential.disconnect(provider),
    refresh: () => seams.credential.refresh(),
  };
}
