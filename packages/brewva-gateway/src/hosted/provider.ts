export type {
  ProviderApiKeyAuthMethod,
  ProviderAuthHandler,
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnectionDescriptor,
  ProviderConnectionGroup,
  ProviderConnectionSource,
  ProviderOAuthAuthMethod,
  ProviderOAuthAuthorization,
  ProviderOAuthCompletion,
} from "./internal/provider/types.js";
export type { ProviderConnectionSeams } from "./internal/provider/connection-types.js";
export {
  configureCredentialVaultModelAuth,
  createProviderConnectionPort,
  createProviderConnectionSeams,
  getProviderCredentialRef,
} from "./internal/provider/connection-port.js";
