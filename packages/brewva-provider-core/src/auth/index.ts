import type { KnownProvider } from "../contracts/index.js";

export function getEnvApiKey(
  provider: KnownProvider,
  env: Record<string, string | undefined>,
): string | undefined;
export function getEnvApiKey(
  provider: string,
  env: Record<string, string | undefined>,
): string | undefined;
export function getEnvApiKey(
  provider: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (provider === "github-copilot") {
    return env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  }

  if (provider === "anthropic") {
    return env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
  }

  if (provider === "moonshot-cn") {
    return env.MOONSHOT_CN_API_KEY;
  }

  if (provider === "moonshot-ai") {
    return env.MOONSHOT_AI_API_KEY;
  }

  if (provider === "google-genai") {
    return env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
  };

  const envVar = envMap[provider];
  return envVar ? env[envVar] : undefined;
}
