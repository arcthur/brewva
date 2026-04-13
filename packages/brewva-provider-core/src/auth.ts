// NEVER convert to top-level imports - breaks browser/Vite builds (web-ui)
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
  dynamicImport(NODE_FS_SPECIFIER).then((m) => {
    _existsSync = (m as typeof import("node:fs")).existsSync;
  });
  dynamicImport(NODE_OS_SPECIFIER).then((m) => {
    _homedir = (m as typeof import("node:os")).homedir;
  });
  dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
    _join = (m as typeof import("node:path")).join;
  });
}

import type { KnownProvider } from "./types.js";

let cachedVertexAdcCredentialsExists: boolean | null = null;

interface GetEnvApiKeyOptions {
  hasVertexAdcCredentials?: () => boolean;
}

function hasVertexAdcCredentials(
  env: Record<string, string | undefined>,
  options: GetEnvApiKeyOptions,
): boolean {
  const override = options.hasVertexAdcCredentials?.();
  if (override !== undefined) {
    return override;
  }

  if (cachedVertexAdcCredentialsExists === null) {
    if (!_existsSync || !_homedir || !_join) {
      const isNode =
        typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
      if (!isNode) {
        cachedVertexAdcCredentialsExists = false;
      }
      return false;
    }

    const gacPath = env.GOOGLE_APPLICATION_CREDENTIALS;
    if (gacPath) {
      cachedVertexAdcCredentialsExists = _existsSync(gacPath);
    } else {
      cachedVertexAdcCredentialsExists = _existsSync(
        _join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
      );
    }
  }
  return cachedVertexAdcCredentialsExists;
}

export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(
  provider: KnownProvider,
  env: Record<string, string | undefined>,
  options?: GetEnvApiKeyOptions,
): string | undefined;
export function getEnvApiKey(
  provider: string,
  env: Record<string, string | undefined>,
  options?: GetEnvApiKeyOptions,
): string | undefined;
export function getEnvApiKey(
  provider: string,
  env: Record<string, string | undefined> = process.env,
  options: GetEnvApiKeyOptions = {},
): string | undefined {
  if (provider === "github-copilot") {
    return env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  }

  if (provider === "anthropic") {
    return env.ANTHROPIC_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
  }

  if (provider === "google-vertex") {
    if (env.GOOGLE_CLOUD_API_KEY) {
      return env.GOOGLE_CLOUD_API_KEY;
    }

    const hasCredentials = hasVertexAdcCredentials(env, options);
    const hasProject = !!(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT);
    const hasLocation = !!env.GOOGLE_CLOUD_LOCATION;

    if (hasCredentials && hasProject && hasLocation) {
      return "<authenticated>";
    }
  }

  if (provider === "amazon-bedrock") {
    if (
      env.AWS_PROFILE ||
      (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
      env.AWS_BEARER_TOKEN_BEDROCK ||
      env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      env.AWS_WEB_IDENTITY_TOKEN_FILE
    ) {
      return "<authenticated>";
    }
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    minimax: "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    huggingface: "HF_TOKEN",
    opencode: "OPENCODE_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
  };

  const envVar = envMap[provider];
  return envVar ? env[envVar] : undefined;
}
