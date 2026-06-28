import type { CredentialVaultService } from "@brewva/brewva-runtime/security";
import type { BrewvaModelCatalog, BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type { BrewvaSessionModelCatalogView } from "@brewva/brewva-substrate/session";
import type { HostedAuthCredential } from "../session/settings/hosted-auth-store.js";
import type { ProviderConnectionDescriptor, ProviderConnectionSource } from "./types.js";

export type ProviderConnectionModelCatalog = Pick<BrewvaSessionModelCatalogView, "getAll"> &
  Partial<Pick<BrewvaSessionModelCatalogView, "getAvailable">> &
  Partial<Pick<BrewvaModelCatalog, "hasConfiguredAuth">> & {
    refresh?: () => void;
  };

export type ProviderConnectionAuthStore = {
  get?(provider: string): HostedAuthCredential | undefined;
  set?(provider: string, credential: HostedAuthCredential): void;
  remove?(provider: string): void;
  setFallbackResolver?: (resolver: (provider: string) => string | undefined) => void;
};

const POPULAR_PROVIDER_ORDER = [
  "openai",
  "openai-codex",
  "anthropic",
  "github-copilot",
  "google",
  "google-genai",
  "deepseek",
  "kimi-coding",
  "openrouter",
] as const;

export const TOKEN_PROVIDERS = new Set(["github-copilot"]);
export const API_KEY_UNSUPPORTED_PROVIDERS = new Set<string>(["google"]);
export const OPENAI_PROVIDER = "openai";
export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const GOOGLE_PROVIDER = "google";
export const GOOGLE_GENAI_PROVIDER = "google-genai";
export const KIMI_PROVIDER = "kimi-coding";
export const KIMI_CODE_PROVIDER = "kimi-coding";
export const MOONSHOT_CN_PROVIDER = "moonshot-cn";
export const MOONSHOT_AI_PROVIDER = "moonshot-ai";
export const KIMI_COVERED_PROVIDERS = [
  KIMI_CODE_PROVIDER,
  MOONSHOT_CN_PROVIDER,
  MOONSHOT_AI_PROVIDER,
] as const;

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-genai": "Google GenAI",
  "kimi-coding": "Kimi",
  "moonshot-ai": "Moonshot AI Open Platform (moonshot.ai)",
  "moonshot-cn": "Moonshot AI Open Platform (moonshot.cn)",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
};

export const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  anthropic: "API key",
  deepseek: "API key",
  "github-copilot": "GitHub OAuth or token",
  google: "Gemini API key",
  "google-genai": "Gemini API key",
  "kimi-coding": "Kimi Code or Moonshot API key",
  "moonshot-ai": "API key",
  "moonshot-cn": "API key",
  openai: "ChatGPT Plus/Pro or API key",
  "openai-codex": "ChatGPT Plus/Pro or API key",
  openrouter: "API key",
};

export function getProviderCredentialRef(provider: string): string {
  return `vault://${provider}/${TOKEN_PROVIDERS.has(provider) ? "token" : "apiKey"}`;
}

export function formatProviderName(provider: string): string {
  return (
    PROVIDER_DISPLAY_NAMES[provider] ??
    provider
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

function providerRank(provider: string): number {
  const index = POPULAR_PROVIDER_ORDER.indexOf(provider as (typeof POPULAR_PROVIDER_ORDER)[number]);
  return index >= 0 ? index : Number.POSITIVE_INFINITY;
}

export function resolveProviderGroup(provider: string): ProviderConnectionDescriptor["group"] {
  return providerRank(provider) === Number.POSITIVE_INFINITY ? "other" : "popular";
}

function providerConnectionSourceRank(source: ProviderConnectionSource): number {
  switch (source) {
    case "oauth":
      return 5;
    case "vault":
      return 4;
    case "provider_config":
      return 2;
    case "none":
      return 1;
  }
  // Exhaustiveness guard: a new ProviderConnectionSource without a rank here is a compile
  // error rather than a silent rank-0 (which would sort it below "none").
  const exhaustiveCheck: never = source;
  return exhaustiveCheck;
}

function pickProviderConnectionSource(
  providers: readonly ProviderConnectionDescriptor[],
): ProviderConnectionSource {
  return (
    providers.toSorted(
      (left, right) =>
        providerConnectionSourceRank(right.connectionSource) -
        providerConnectionSourceRank(left.connectionSource),
    )[0]?.connectionSource ?? "none"
  );
}

export function sortProviders(
  left: ProviderConnectionDescriptor,
  right: ProviderConnectionDescriptor,
): number {
  if (left.group !== right.group) {
    return left.group === "popular" ? -1 : 1;
  }
  const leftRank = providerRank(left.id);
  const rightRank = providerRank(right.id);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function consolidateOpenAIConnectionProviders(
  providers: readonly ProviderConnectionDescriptor[],
): ProviderConnectionDescriptor[] {
  const openAI = providers.find((provider) => provider.id === OPENAI_PROVIDER);
  const openAICodex = providers.find((provider) => provider.id === OPENAI_CODEX_PROVIDER);
  if (!openAI && !openAICodex) {
    return [...providers];
  }

  const coveredProviders = [openAI, openAICodex].filter(
    (provider): provider is ProviderConnectionDescriptor => provider !== undefined,
  );
  const consolidated: ProviderConnectionDescriptor = {
    id: OPENAI_PROVIDER,
    name: formatProviderName(OPENAI_PROVIDER),
    group: "popular",
    connected: coveredProviders.some((provider) => provider.connected),
    connectionSource: pickProviderConnectionSource(coveredProviders),
    description: PROVIDER_DESCRIPTIONS[OPENAI_PROVIDER],
    modelProviders: coveredProviders.map((provider) => provider.id),
    modelCount: coveredProviders.reduce((sum, provider) => sum + provider.modelCount, 0),
    availableModelCount: coveredProviders.reduce(
      (sum, provider) => sum + provider.availableModelCount,
      0,
    ),
    credentialRef: getProviderCredentialRef(OPENAI_PROVIDER),
  };

  return [
    consolidated,
    ...providers.filter(
      (provider) => provider.id !== OPENAI_PROVIDER && provider.id !== OPENAI_CODEX_PROVIDER,
    ),
  ].toSorted(sortProviders);
}

function consolidateGoogleConnectionProviders(
  providers: readonly ProviderConnectionDescriptor[],
): ProviderConnectionDescriptor[] {
  const googleGenAI = providers.find((provider) => provider.id === GOOGLE_GENAI_PROVIDER);
  if (!googleGenAI) {
    return [...providers];
  }

  const consolidated: ProviderConnectionDescriptor = {
    id: GOOGLE_PROVIDER,
    name: formatProviderName(GOOGLE_PROVIDER),
    group: "popular",
    connected: googleGenAI.connected,
    connectionSource: googleGenAI.connectionSource,
    description: PROVIDER_DESCRIPTIONS[GOOGLE_PROVIDER],
    modelProviders: [googleGenAI.id],
    modelCount: googleGenAI.modelCount,
    availableModelCount: googleGenAI.availableModelCount,
    credentialRef: getProviderCredentialRef(GOOGLE_GENAI_PROVIDER),
  };

  return [
    consolidated,
    ...providers.filter((provider) => provider.id !== GOOGLE_GENAI_PROVIDER),
  ].toSorted(sortProviders);
}

function consolidateKimiConnectionProviders(
  providers: readonly ProviderConnectionDescriptor[],
): ProviderConnectionDescriptor[] {
  const coveredProviders = KIMI_COVERED_PROVIDERS.map((providerId) =>
    providers.find((provider) => provider.id === providerId),
  ).filter((provider): provider is ProviderConnectionDescriptor => provider !== undefined);

  if (coveredProviders.length === 0) {
    return [...providers];
  }

  const consolidated: ProviderConnectionDescriptor = {
    id: KIMI_PROVIDER,
    name: formatProviderName(KIMI_PROVIDER),
    group: "popular",
    connected: coveredProviders.some((provider) => provider.connected),
    connectionSource: pickProviderConnectionSource(coveredProviders),
    description: PROVIDER_DESCRIPTIONS[KIMI_PROVIDER],
    modelProviders: coveredProviders.map((provider) => provider.id),
    modelCount: coveredProviders.reduce((sum, provider) => sum + provider.modelCount, 0),
    availableModelCount: coveredProviders.reduce(
      (sum, provider) => sum + provider.availableModelCount,
      0,
    ),
    credentialRef: getProviderCredentialRef(KIMI_CODE_PROVIDER),
  };

  const covered = new Set<string>(KIMI_COVERED_PROVIDERS);
  return [consolidated, ...providers.filter((provider) => !covered.has(provider.id))].toSorted(
    sortProviders,
  );
}

export function consolidateConnectionProviders(
  providers: readonly ProviderConnectionDescriptor[],
): ProviderConnectionDescriptor[] {
  return consolidateKimiConnectionProviders(
    consolidateGoogleConnectionProviders(consolidateOpenAIConnectionProviders(providers)),
  );
}

export async function listAvailableModels(
  modelRegistry: ProviderConnectionModelCatalog,
): Promise<readonly BrewvaRegisteredModel[]> {
  const available = modelRegistry.getAvailable?.();
  if (!available) {
    return [];
  }
  return [...(await Promise.resolve(available))] as readonly BrewvaRegisteredModel[];
}

export function groupModelsByProvider(
  models: readonly BrewvaRegisteredModel[],
): Map<string, BrewvaRegisteredModel[]> {
  const grouped = new Map<string, BrewvaRegisteredModel[]>();
  for (const model of models) {
    const modelsForProvider = grouped.get(model.provider) ?? [];
    modelsForProvider.push(model);
    grouped.set(model.provider, modelsForProvider);
  }
  return grouped;
}

function hasVaultCredential(vault: CredentialVaultService, provider: string): boolean {
  try {
    return vault.get(getProviderCredentialRef(provider)) !== undefined;
  } catch {
    return false;
  }
}

export function resolveConnectionSource(input: {
  vault: CredentialVaultService;
  authStore?: ProviderConnectionAuthStore;
  provider: string;
  connected: boolean;
}): ProviderConnectionSource {
  const credential = input.authStore?.get?.(input.provider);
  if (credential?.type === "oauth") {
    return "oauth";
  }
  if (hasVaultCredential(input.vault, input.provider)) {
    return "vault";
  }
  return input.connected ? "provider_config" : "none";
}
