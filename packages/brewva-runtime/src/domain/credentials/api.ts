export type {
  CredentialVaultDiscoveredEntry,
  CredentialVaultListEntry,
  CredentialVaultServiceOptions,
} from "./types.js";
export {
  createCredentialsSurfaceMethods,
  credentialsRuntimeSurface,
  credentialsSurfaceContribution,
} from "./runtime-surface.js";
export type { RuntimeCredentialsSurfaceMethods } from "./runtime-surface.js";
export { registerCredentialsDomain } from "./registrar.js";
export type { RuntimeCredentialsDomainRegistration } from "./registrar.js";
export {
  CredentialVaultService,
  createCredentialVaultServiceFromSecurityConfig,
} from "./credential-vault.js";
