import {
  CredentialVaultService as InternalCredentialVaultService,
  createCredentialVaultServiceFromSecurityConfig as createInternalCredentialVaultServiceFromSecurityConfig,
} from "./domain/credentials/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const CREDENTIAL_VAULT_SERVICE_METHODS = [
  "get",
  "put",
  "remove",
  "list",
  "discover",
  "resolveToolBindings",
  "resolveConfiguredSecret",
] as const satisfies readonly (keyof InstanceType<typeof InternalCredentialVaultService>)[];

export type CredentialVaultService = ExtensionPort<
  "credentials.vault",
  Pick<
    InstanceType<typeof InternalCredentialVaultService>,
    (typeof CREDENTIAL_VAULT_SERVICE_METHODS)[number]
  >
>;
export type {
  CredentialVaultDiscoveredEntry,
  CredentialVaultListEntry,
  CredentialVaultServiceOptions,
} from "./domain/credentials/api.js";

export function createCredentialVaultService(
  options: ConstructorParameters<typeof InternalCredentialVaultService>[0],
): CredentialVaultService {
  return createBoundExtensionPort({
    name: "credentials.vault",
    instance: new InternalCredentialVaultService(options),
    methods: CREDENTIAL_VAULT_SERVICE_METHODS,
  });
}

export function createCredentialVaultServiceFromSecurityConfig(
  ...args: Parameters<typeof createInternalCredentialVaultServiceFromSecurityConfig>
): CredentialVaultService {
  return createBoundExtensionPort({
    name: "credentials.vault",
    instance: createInternalCredentialVaultServiceFromSecurityConfig(...args),
    methods: CREDENTIAL_VAULT_SERVICE_METHODS,
  });
}
