import type { BrewvaRegisteredModel } from "../contracts/provider.js";

export interface BrewvaProviderCompletionAuth {
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface BrewvaProviderCompletionRequest {
  model: BrewvaRegisteredModel;
  systemPrompt: string;
  userText: string;
  auth: BrewvaProviderCompletionAuth;
}

export interface BrewvaProviderCompletionUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: {
    total?: number;
  };
}

export interface BrewvaProviderCompletionResponse {
  role?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  timestamp?: number;
  usage?: BrewvaProviderCompletionUsage;
  content?: unknown;
}

export interface BrewvaProviderCompletionDriver {
  complete(input: BrewvaProviderCompletionRequest): Promise<BrewvaProviderCompletionResponse>;
}
