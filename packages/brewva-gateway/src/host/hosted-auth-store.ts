import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveHostedConfigValue } from "./hosted-config-value.js";
import { getHostedEnvApiKey } from "./hosted-provider-helpers.js";

export type HostedAuthCredential =
  | {
      type: "api_key";
      key: string;
    }
  | ({
      type: "oauth";
      accessToken?: string;
    } & Record<string, unknown>);

type HostedAuthStorageData = Record<string, HostedAuthCredential>;

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
    return (
      this.#runtimeOverrides.has(provider) ||
      this.#data[provider] !== undefined ||
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
    if (credential?.type === "oauth" && typeof credential.accessToken === "string") {
      return credential.accessToken;
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

  set(provider: string, credential: HostedAuthCredential): void {
    this.#data[provider] = credential;
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
