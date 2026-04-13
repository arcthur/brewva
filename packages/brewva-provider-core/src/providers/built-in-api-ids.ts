export const BUILT_IN_API_PROVIDER_APIS = [
  "anthropic-messages",
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "bedrock-converse-stream",
] as const;

export type BuiltInApiProviderApi = (typeof BUILT_IN_API_PROVIDER_APIS)[number];
