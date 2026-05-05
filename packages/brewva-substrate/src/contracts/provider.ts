import type { BrewvaReasoningThinkingLevel } from "./thinking.js";

export type BrewvaKnownApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-gemini-cli";

export type BrewvaApi = BrewvaKnownApi | (string & {});

export interface BrewvaOpenRouterRouting {
  only?: string[];
  order?: string[];
}

export interface BrewvaOpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Partial<Record<BrewvaReasoningThinkingLevel, string>>;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "qwen" | "qwen-chat-template" | "deepseek";
  openRouterRouting?: BrewvaOpenRouterRouting;
  supportsStrictMode?: boolean;
}

export interface BrewvaOpenAIResponsesCompat {}

export type BrewvaModelCompat =
  | BrewvaOpenAICompletionsCompat
  | BrewvaOpenAIResponsesCompat
  | undefined;

export interface BrewvaRegisteredModel {
  provider: string;
  id: string;
  name: string;
  api: BrewvaApi;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: BrewvaModelCompat;
  displayName?: string;
}

export interface BrewvaProviderModelDefinition {
  id: string;
  name: string;
  api: BrewvaApi;
  baseUrl?: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: BrewvaModelCompat;
  displayName?: string;
}

export interface BrewvaProviderRegistration {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: BrewvaProviderModelDefinition[];
}

export interface BrewvaProviderAuthStore {
  getApiKey(provider: string): Promise<string | undefined> | string | undefined;
  hasAuth?(provider: string): boolean;
  isUsingOAuth?(provider: string): boolean;
}

export type BrewvaResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

export interface BrewvaModelCatalog {
  getAll(): BrewvaRegisteredModel[];
  getAvailable(): Promise<BrewvaRegisteredModel[]> | BrewvaRegisteredModel[];
  find(provider: string, modelId: string): BrewvaRegisteredModel | undefined;
  hasConfiguredAuth(model: BrewvaRegisteredModel): boolean;
  getApiKeyAndHeaders(model: BrewvaRegisteredModel): Promise<BrewvaResolvedRequestAuth>;
}

export interface BrewvaMutableModelCatalog extends BrewvaModelCatalog {
  registerProvider(providerName: string, config: BrewvaProviderRegistration): void;
  unregisterProvider(providerName: string): void;
  isUsingOAuth(model: BrewvaRegisteredModel): boolean;
}
