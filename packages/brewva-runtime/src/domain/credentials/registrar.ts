import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { createCredentialVaultServiceFromSecurityConfig } from "./credential-vault.js";
import type { CredentialVaultService } from "./credential-vault.js";

export interface RuntimeCredentialsDomainRegistration {
  lazyFactories: {
    createCredentialVaultService(): CredentialVaultService;
  };
}

export function registerCredentialsDomain(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeCredentialsDomainRegistration {
  return {
    lazyFactories: {
      createCredentialVaultService: () =>
        createCredentialVaultServiceFromSecurityConfig(
          options.workspaceRoot,
          options.config.security,
        ),
    },
  };
}
