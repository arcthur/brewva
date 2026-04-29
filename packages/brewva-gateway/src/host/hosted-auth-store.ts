import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GOOGLE_OAUTH_PROVIDER,
  refreshGoogleOAuthAccessToken,
  renderGoogleCloudCodeAssistCredential,
  type GoogleHostedOAuthCredential,
} from "./google-oauth.js";
import { resolveHostedConfigValue } from "./hosted-config-value.js";
import { getHostedEnvApiKey } from "./hosted-provider-helpers.js";

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CHATGPT_OAUTH_PROVIDERS = new Set(["openai", "openai-codex"]);

export type HostedAuthCredential =
  | {
      type: "api_key";
      key: string;
    }
  | ({
      type: "oauth";
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      access?: string;
      refresh?: string;
      expires?: number;
    } & Record<string, unknown>);

type HostedAuthStorageData = Record<string, HostedAuthCredential>;

interface ResolvedOAuthCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasUsableGoogleOAuthCredential(credential: HostedAuthCredential | undefined): boolean {
  if (credential?.type !== "oauth") {
    return false;
  }
  return (
    renderGoogleCloudCodeAssistCredential(credential as GoogleHostedOAuthCredential) !== undefined
  );
}

async function refreshOpenAIChatGPTAccessToken(
  refreshToken: string,
): Promise<Required<Pick<ResolvedOAuthCredential, "accessToken">> & ResolvedOAuthCredential> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  const nextAccessToken = readString(payload.access_token);
  if (!nextAccessToken) {
    throw new Error("Token refresh response was missing access_token.");
  }

  const expiresInSeconds = readFiniteNumber(payload.expires_in);
  return {
    accessToken: nextAccessToken,
    refreshToken: readString(payload.refresh_token),
    expiresAt:
      typeof expiresInSeconds === "number"
        ? Date.now() + Math.max(0, expiresInSeconds) * 1000
        : undefined,
  };
}

export class HostedAuthStore {
  readonly #authPath: string | undefined;
  #data: HostedAuthStorageData = {};
  #fallbackResolver?: (provider: string) => string | undefined;
  readonly #runtimeOverrides = new Map<string, string>();

  private constructor(authPath?: string, initialData?: HostedAuthStorageData) {
    this.#authPath = authPath;
    if (initialData) {
      this.#data = { ...initialData };
    } else {
      this.reload();
    }
  }

  static create(authPath: string): HostedAuthStore {
    return new HostedAuthStore(authPath);
  }

  static inMemory(data: HostedAuthStorageData = {}): HostedAuthStore {
    return new HostedAuthStore(undefined, data);
  }

  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.#fallbackResolver = resolver;
  }

  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.#runtimeOverrides.set(provider, apiKey);
  }

  get(provider: string): HostedAuthCredential | undefined {
    return this.#data[provider];
  }

  hasAuth(provider: string): boolean {
    const storedCredential = this.#data[provider];
    return (
      this.#runtimeOverrides.has(provider) ||
      (provider === GOOGLE_OAUTH_PROVIDER
        ? hasUsableGoogleOAuthCredential(storedCredential)
        : storedCredential !== undefined) ||
      getHostedEnvApiKey(provider) !== undefined ||
      this.#fallbackResolver?.(provider) !== undefined
    );
  }

  reload(): void {
    if (!this.#authPath || !existsSync(this.#authPath)) {
      this.#data = {};
      return;
    }
    try {
      this.#data = JSON.parse(readFileSync(this.#authPath, "utf8")) as HostedAuthStorageData;
    } catch {
      this.#data = {};
    }
  }

  async getApiKey(
    provider: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined> {
    const runtimeKey = this.#runtimeOverrides.get(provider);
    if (runtimeKey) {
      return runtimeKey;
    }

    const credential = this.#data[provider];
    if (credential?.type === "api_key") {
      return resolveHostedConfigValue(credential.key);
    }
    if (credential?.type === "oauth") {
      if (provider === GOOGLE_OAUTH_PROVIDER) {
        return this.resolveGoogleOAuthApiKey(provider, credential);
      }
      return this.resolveOAuthAccessToken(provider, credential);
    }

    const envKey = getHostedEnvApiKey(provider);
    if (envKey) {
      return envKey;
    }

    if (options?.includeFallback !== false) {
      return this.#fallbackResolver?.(provider);
    }
    return undefined;
  }

  private async resolveOAuthAccessToken(
    provider: string,
    credential: Extract<HostedAuthCredential, { type: "oauth" }>,
  ): Promise<string | undefined> {
    const accessToken = readString(credential.accessToken) ?? readString(credential.access);
    const refreshToken = readString(credential.refreshToken) ?? readString(credential.refresh);
    const expiresAt =
      readFiniteNumber(credential.expiresAt) ?? readFiniteNumber(credential.expires);

    if (accessToken && (!expiresAt || expiresAt > Date.now())) {
      return accessToken;
    }

    if (!OPENAI_CHATGPT_OAUTH_PROVIDERS.has(provider) || !refreshToken) {
      return accessToken;
    }

    const refreshed = await refreshOpenAIChatGPTAccessToken(refreshToken);
    const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
    const nextCredential: Extract<HostedAuthCredential, { type: "oauth" }> = {
      ...credential,
      type: "oauth",
      accessToken: refreshed.accessToken,
      refreshToken: nextRefreshToken,
      expiresAt: refreshed.expiresAt,
      access: refreshed.accessToken,
      refresh: nextRefreshToken,
      expires: refreshed.expiresAt,
    };
    this.#data[provider] = nextCredential;
    this.persist();
    return refreshed.accessToken;
  }

  private async resolveGoogleOAuthApiKey(
    provider: string,
    credential: Extract<HostedAuthCredential, { type: "oauth" }>,
  ): Promise<string | undefined> {
    const googleCredential = credential as GoogleHostedOAuthCredential;
    const accessToken =
      readString(googleCredential.accessToken) ?? readString(googleCredential.access);
    const refreshToken =
      readString(googleCredential.refreshToken) ?? readString(googleCredential.refresh);
    const expiresAt =
      readFiniteNumber(googleCredential.expiresAt) ?? readFiniteNumber(googleCredential.expires);

    if (accessToken && (!expiresAt || expiresAt > Date.now())) {
      return renderGoogleCloudCodeAssistCredential(googleCredential);
    }

    if (!refreshToken) {
      return renderGoogleCloudCodeAssistCredential(googleCredential);
    }

    const refreshed = await refreshGoogleOAuthAccessToken(refreshToken);
    const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
    const nextExpiresAt =
      typeof refreshed.expiresIn === "number"
        ? Date.now() + Math.max(0, refreshed.expiresIn) * 1000
        : undefined;
    const nextCredential: Extract<HostedAuthCredential, { type: "oauth" }> = {
      ...credential,
      type: "oauth",
      accessToken: refreshed.accessToken,
      refreshToken: nextRefreshToken,
      expiresAt: nextExpiresAt,
      access: refreshed.accessToken,
      refresh: nextRefreshToken,
      expires: nextExpiresAt,
      tokenType: refreshed.tokenType ?? googleCredential.tokenType,
      scope: refreshed.scope ?? googleCredential.scope,
    };
    this.#data[provider] = nextCredential;
    this.persist();
    return renderGoogleCloudCodeAssistCredential(nextCredential as GoogleHostedOAuthCredential);
  }

  set(provider: string, credential: HostedAuthCredential): void {
    this.#data[provider] = credential;
    this.persist();
  }

  remove(provider: string): void {
    delete this.#data[provider];
    this.persist();
  }

  private persist(): void {
    if (!this.#authPath) {
      return;
    }
    mkdirSync(dirname(this.#authPath), { recursive: true });
    writeFileSync(this.#authPath, JSON.stringify(this.#data, null, 2), "utf8");
  }
}
