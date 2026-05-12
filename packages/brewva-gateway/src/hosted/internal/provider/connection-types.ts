import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "./types.js";

export interface ProviderCredentialPort {
  listProviders(): Promise<readonly ProviderConnectionDescriptor[]>;
  connectApiKey(provider: string, key: string, inputs?: Record<string, string>): Promise<void>;
  disconnect(provider: string): Promise<void>;
  refresh(): Promise<void>;
}

export interface ProviderAuthFlowPort {
  listAuthMethods(provider: string): readonly ProviderAuthMethod[];
  authorizeOAuth(
    provider: string,
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthAuthorization | undefined>;
  completeOAuth(provider: string, methodId: string, code?: string): Promise<void>;
}

export interface ProviderCatalogPort {
  listProviders(): Promise<readonly ProviderConnectionDescriptor[]>;
}

export interface ProviderRendererPort {
  listAuthMethods(provider: string): readonly ProviderAuthMethod[];
}

export interface ProviderConnectionSeams {
  credential: ProviderCredentialPort;
  authFlow: ProviderAuthFlowPort;
  catalog: ProviderCatalogPort;
  renderer: ProviderRendererPort;
}

export interface ProviderConnectionPort {
  listProviders(): Promise<ProviderConnectionDescriptor[]>;
  listAuthMethods(provider: string): ProviderAuthMethod[];
  connectApiKey(provider: string, key: string, inputs?: Record<string, string>): Promise<void>;
  authorizeOAuth(
    provider: string,
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthAuthorization | undefined>;
  completeOAuth(provider: string, methodId: string, code?: string): Promise<void>;
  disconnect(provider: string): Promise<void>;
  refresh(): Promise<void>;
}
