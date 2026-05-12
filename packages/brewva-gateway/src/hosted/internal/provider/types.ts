import type { HostedAuthCredential } from "../session/settings/hosted-auth-store.js";

export type ProviderConnectionGroup = "popular" | "other";
export type ProviderConnectionSource = "oauth" | "vault" | "provider_config" | "none";

export interface ProviderConnectionDescriptor {
  id: string;
  name: string;
  description?: string;
  modelProviders?: string[];
  group: ProviderConnectionGroup;
  connected: boolean;
  connectionSource: ProviderConnectionSource;
  modelCount: number;
  availableModelCount: number;
  credentialRef: string;
}

export interface ProviderAuthPromptCondition {
  key: string;
  op: "eq" | "neq";
  value: string;
}

export interface ProviderAuthTextPrompt {
  type: "text";
  key: string;
  message: string;
  placeholder?: string;
  masked?: boolean;
  when?: ProviderAuthPromptCondition;
}

export interface ProviderAuthSelectPrompt {
  type: "select";
  key: string;
  message: string;
  options: Array<{
    label: string;
    value: string;
    hint?: string;
  }>;
  when?: ProviderAuthPromptCondition;
}

export type ProviderAuthPrompt = ProviderAuthTextPrompt | ProviderAuthSelectPrompt;

export interface ProviderApiKeyAuthMethod {
  id: string;
  kind: "api_key";
  type: "api";
  label: string;
  detail?: string;
  credentialRef: string;
  credentialProvider?: string;
  modelProviderFilter?: string;
  prompts?: ProviderAuthPrompt[];
}

export interface ProviderOAuthAuthMethod {
  id: string;
  kind: "oauth";
  type: "oauth";
  label: string;
  detail?: string;
  credentialProvider?: string;
  modelProviderFilter?: string;
  prompts?: ProviderAuthPrompt[];
}

export type ProviderAuthMethod = ProviderApiKeyAuthMethod | ProviderOAuthAuthMethod;

export interface ProviderOAuthAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
  copyText?: string;
  openBrowser?: boolean;
  manualCode?: {
    prompt: string;
  };
}

export interface ProviderOAuthCompletion extends ProviderOAuthAuthorization {
  complete(code?: string): Promise<HostedAuthCredential>;
}

export interface ProviderAuthHandler {
  provider: string;
  listAuthMethods(): readonly ProviderOAuthAuthMethod[];
  authorizeOAuth(
    methodId: string,
    inputs?: Record<string, string>,
  ): Promise<ProviderOAuthCompletion | undefined>;
}
