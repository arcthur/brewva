import { createGitHubCopilotAuthHandler } from "./oauth/github-copilot.js";
import { createGoogleGeminiAuthHandler } from "./oauth/google.js";
import { createOpenAIChatGPTAuthHandler } from "./oauth/openai-codex.js";
import { OPENAI_CODEX_PROVIDER } from "./shared.js";
import type { ProviderAuthHandler } from "./types.js";

export function createBuiltInProviderAuthHandlers(): ProviderAuthHandler[] {
  return [
    createOpenAIChatGPTAuthHandler(OPENAI_CODEX_PROVIDER),
    createGitHubCopilotAuthHandler(),
    createGoogleGeminiAuthHandler(),
  ];
}
