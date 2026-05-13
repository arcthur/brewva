export type {
  CredentialVaultDiscoveredEntry,
  CredentialVaultListEntry,
  CredentialVaultServiceOptions,
} from "./types.js";
export { registerCredentialsDomain } from "./registrar.js";
export type { RuntimeCredentialsDomainRegistration } from "./registrar.js";
export {
  CredentialVaultService,
  createCredentialVaultServiceFromSecurityConfig,
} from "./credential-vault.js";
