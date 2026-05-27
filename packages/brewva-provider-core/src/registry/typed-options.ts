import type { Api } from "../contracts/index.js";
import type { SimpleStreamOptions } from "../contracts/index.js";
import type { AnthropicOptions } from "../providers/anthropic/index.js";
import type { GoogleGenAIOptions } from "../providers/google-genai/index.js";
import type { OpenAICodexResponsesOptions } from "../providers/openai-codex-responses/index.js";
import type { OpenAICompletionsOptions } from "../providers/openai-completions/index.js";
import type { OpenAIResponsesOptions } from "../providers/openai-responses/index.js";

export interface ProviderOptionsByApi {
  "anthropic-messages": AnthropicOptions;
  "openai-completions": OpenAICompletionsOptions;
  "openai-responses": OpenAIResponsesOptions;
  "openai-codex-responses": OpenAICodexResponsesOptions;
  "google-genai": GoogleGenAIOptions;
}

export const TYPED_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "google-genai",
] as const satisfies readonly (keyof ProviderOptionsByApi)[];

export type ProviderApiWithTypedOptions = keyof ProviderOptionsByApi;
export type ProviderSimpleOptionsByApi = {
  [K in ProviderApiWithTypedOptions]: SimpleStreamOptions;
};

export function isProviderApiWithTypedOptions(api: Api): api is ProviderApiWithTypedOptions {
  return (TYPED_PROVIDER_APIS as readonly string[]).includes(api);
}
