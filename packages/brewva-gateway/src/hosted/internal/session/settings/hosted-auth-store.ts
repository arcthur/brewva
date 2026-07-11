import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import { resolveHostedConfigValue } from "./hosted-config-value.js";

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

export type HostedCredentialRotationReason = "quota" | "rate_limit" | "auth" | "manual";

export interface HostedAuthCredentialSlot {
  id: string;
  credential: HostedAuthCredential;
  cooldownUntil?: number;
}

interface HostedAuthProviderCredentials {
  activeSlot: string;
  slots: Record<string, HostedAuthCredentialSlot>;
}

type HostedAuthStorageData = Record<string, HostedAuthProviderCredentials>;

interface ResolvedOAuthCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

function readString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return readFiniteNumberValue(value);
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
      this.#data = normalizeStorageData(initialData);
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
    return this.getActiveSlot(provider)?.credential;
  }

  hasAuth(provider: string): boolean {
    const storedCredential = this.get(provider);
    return (
      this.#runtimeOverrides.has(provider) ||
      storedCredential !== undefined ||
      this.#fallbackResolver?.(provider) !== undefined
    );
  }

  reload(): void {
    if (!this.#authPath || !existsSync(this.#authPath)) {
      this.#data = {};
      return;
    }
    this.#data = normalizeStorageData(JSON.parse(readFileSync(this.#authPath, "utf8")));
  }

  async getApiKey(
    provider: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined> {
    const runtimeKey = this.#runtimeOverrides.get(provider);
    if (runtimeKey) {
      return runtimeKey;
    }

    const credential = this.get(provider);
    if (credential?.type === "api_key") {
      return resolveHostedConfigValue(credential.key);
    }
    if (credential?.type === "oauth") {
      return this.resolveOAuthAccessToken(provider, credential);
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
    this.replaceActiveCredential(provider, nextCredential);
    this.persist();
    return refreshed.accessToken;
  }

  set(provider: string, credential: HostedAuthCredential): void {
    const id = "default";
    this.#data[provider] = {
      activeSlot: id,
      slots: {
        [id]: {
          id,
          credential,
        },
      },
    };
    this.persist();
  }

  setCredentialSlot(provider: string, slot: HostedAuthCredentialSlot): void {
    const current =
      this.#data[provider] ??
      ({
        activeSlot: slot.id,
        slots: {},
      } satisfies HostedAuthProviderCredentials);
    current.slots[slot.id] = { ...slot, credential: { ...slot.credential } };
    if (!current.activeSlot || !current.slots[current.activeSlot]) {
      current.activeSlot = slot.id;
    }
    this.#data[provider] = current;
    this.persist();
  }

  rotateCredential(
    provider: string,
    reason: HostedCredentialRotationReason,
    cooldownMs: number,
  ):
    | {
        providerId: string;
        credentialSlot: string;
        reason: HostedCredentialRotationReason;
        cooldownMs: number;
      }
    | undefined {
    const entry = this.#data[provider];
    if (!entry) {
      return undefined;
    }
    const now = Date.now();
    const current = entry.slots[entry.activeSlot];
    if (current) {
      current.cooldownUntil = now + Math.max(0, cooldownMs);
    }
    const next = Object.values(entry.slots)
      .filter((slot) => slot.id !== entry.activeSlot)
      .find((slot) => !slot.cooldownUntil || slot.cooldownUntil <= now);
    if (!next) {
      this.persist();
      return undefined;
    }
    entry.activeSlot = next.id;
    this.persist();
    return {
      providerId: provider,
      credentialSlot: next.id,
      reason,
      cooldownMs: Math.max(0, cooldownMs),
    };
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

  private getActiveSlot(provider: string): HostedAuthCredentialSlot | undefined {
    const entry = this.#data[provider];
    return entry?.slots[entry.activeSlot];
  }

  private replaceActiveCredential(provider: string, credential: HostedAuthCredential): void {
    const entry = this.#data[provider];
    const slot = entry?.slots[entry.activeSlot];
    if (!entry || !slot) {
      this.set(provider, credential);
      return;
    }
    slot.credential = credential;
  }
}

function isProviderCredentials(value: unknown): value is HostedAuthProviderCredentials {
  return (
    isRecord(value) &&
    typeof (value as { activeSlot?: unknown }).activeSlot === "string" &&
    Boolean((value as { slots?: unknown }).slots) &&
    typeof (value as { slots?: unknown }).slots === "object" &&
    !Array.isArray((value as { slots?: unknown }).slots)
  );
}

function isHostedAuthCredential(value: unknown): value is HostedAuthCredential {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "api_key") {
    return readString(value.key) !== undefined;
  }
  return value.type === "oauth";
}

function assertStorageError(message: string): never {
  throw new Error(`Invalid hosted auth storage: ${message}`);
}

function normalizeStorageData(input: unknown): HostedAuthStorageData {
  if (!isRecord(input)) {
    assertStorageError("root must be an object keyed by provider id.");
  }
  const normalized: HostedAuthStorageData = {};
  for (const [provider, value] of Object.entries(input)) {
    if (!readString(provider)) {
      assertStorageError("provider ids must be non-empty strings.");
    }
    if (!isProviderCredentials(value)) {
      assertStorageError(`provider "${provider}" must use credential slots.`);
    }
    const slots: Record<string, HostedAuthCredentialSlot> = {};
    for (const [slotId, rawSlot] of Object.entries(value.slots)) {
      if (!readString(slotId)) {
        assertStorageError(`provider "${provider}" has an empty credential slot id.`);
      }
      if (!isRecord(rawSlot)) {
        assertStorageError(`provider "${provider}" slot "${slotId}" must be an object.`);
      }
      const id = readString(rawSlot.id);
      if (!id || id !== slotId) {
        assertStorageError(`provider "${provider}" slot "${slotId}" id must match its key.`);
      }
      if (!isHostedAuthCredential(rawSlot.credential)) {
        assertStorageError(`provider "${provider}" slot "${slotId}" has an invalid credential.`);
      }
      const cooldownUntil = readFiniteNumber(rawSlot.cooldownUntil);
      slots[slotId] = {
        id: slotId,
        credential: { ...rawSlot.credential },
        ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
      };
    }
    if (!slots[value.activeSlot]) {
      assertStorageError(`provider "${provider}" active slot does not exist.`);
    }
    normalized[provider] = {
      activeSlot: value.activeSlot,
      slots,
    };
  }
  return normalized;
}
