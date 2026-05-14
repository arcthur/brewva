import type {
  BrewvaModelPreferences,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
} from "../../domain/overlays/payloads.js";

export const RECENT_MODEL_LIMIT = 10;
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
};

export function modelKey(model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function fuzzySearchScore(query: string, target: string): number | null {
  const normalizedQuery = normalizeSearchText(query.trim());
  const normalizedTarget = normalizeSearchText(target);
  if (!normalizedQuery) {
    return 0;
  }
  if (!normalizedTarget) {
    return null;
  }
  if (normalizedTarget === normalizedQuery) {
    return 10_000 - normalizedTarget.length;
  }
  if (normalizedTarget.startsWith(normalizedQuery)) {
    return 8_000 - normalizedTarget.length;
  }
  const containsIndex = normalizedTarget.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return 6_000 - containsIndex * 4 - normalizedTarget.length;
  }

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -2;
  let firstMatchIndex = -1;
  for (let targetIndex = 0; targetIndex < normalizedTarget.length; targetIndex++) {
    if (normalizedTarget[targetIndex] !== normalizedQuery[queryIndex]) {
      continue;
    }
    if (firstMatchIndex === -1) {
      firstMatchIndex = targetIndex;
    }
    score += lastMatchIndex === targetIndex - 1 ? 14 : 3;
    score -= Math.max(0, targetIndex - lastMatchIndex - 1);
    lastMatchIndex = targetIndex;
    queryIndex++;
    if (queryIndex >= normalizedQuery.length) {
      break;
    }
  }
  if (queryIndex < normalizedQuery.length) {
    return null;
  }
  return 1_000 + score - Math.max(0, firstMatchIndex) * 2 - normalizedTarget.length;
}

function bestSearchScore(query: string, candidates: readonly string[]): number | null {
  const normalized = query.trim();
  if (!normalized) {
    return 0;
  }
  let best: number | null = null;
  for (const candidate of candidates) {
    const score = fuzzySearchScore(normalized, candidate);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }
  return best;
}

export function providerSearchScore(
  provider: ProviderConnectionDescriptor,
  query: string,
): number | null {
  return bestSearchScore(query, [
    provider.id,
    provider.name,
    provider.description ?? "",
    provider.connectionSource,
    ...(provider.modelProviders ?? []),
  ]);
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export function providerCoversModelProvider(
  provider: ProviderConnectionDescriptor,
  modelProvider: string,
): boolean {
  return provider.id === modelProvider || (provider.modelProviders ?? []).includes(modelProvider);
}

export function authMethodCredentialProvider(
  providerId: string,
  method: ProviderAuthMethod,
): string {
  return method.credentialProvider ?? providerId;
}

export function authMethodModelProviderFilter(
  providerId: string,
  method: ProviderAuthMethod,
): string {
  return method.modelProviderFilter ?? method.credentialProvider ?? providerId;
}

export function providerConnectionFooter(provider: ProviderConnectionDescriptor): string {
  if (!provider.connected) {
    if (provider.id === "openai" || provider.id === "openai-codex") {
      return "OAuth/API key";
    }
    if (provider.id === "google") {
      return "OAuth/import";
    }
    if (provider.id === "kimi-coding") {
      return "Kimi Code/Moonshot API key";
    }
    if (provider.id === "github-copilot") {
      return "OAuth/token";
    }
    return "API key";
  }
  switch (provider.connectionSource) {
    case "oauth":
      return "OAuth";
    case "vault":
      return "Vault";
    case "provider_config":
      return "Config";
    case "none":
      return "Connected";
  }
  return "Connected";
}

export function modelSearchScore(
  model: BrewvaSessionModelDescriptor,
  query: string,
): number | null {
  return bestSearchScore(query, [
    model.provider,
    model.id,
    model.name ?? "",
    model.displayName ?? "",
    `${model.provider}/${model.id}`,
  ]);
}

export function modelMatchesQuery(model: BrewvaSessionModelDescriptor, query: string): boolean {
  return modelSearchScore(model, query) !== null;
}

export function compactModelPreferences(
  preferences: BrewvaModelPreferences,
): BrewvaModelPreferences {
  const normalize = (
    entries: readonly Pick<BrewvaSessionModelDescriptor, "provider" | "id">[],
    limit?: number,
  ) => {
    const seen = new Set<string>();
    const output: Array<{ provider: string; id: string }> = [];
    for (const entry of entries) {
      const key = modelKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push({ provider: entry.provider, id: entry.id });
      if (limit && output.length >= limit) {
        break;
      }
    }
    return output;
  };
  return {
    recent: normalize(preferences.recent, RECENT_MODEL_LIMIT),
    favorite: normalize(preferences.favorite),
  };
}

export function modelDisplayName(model: BrewvaSessionModelDescriptor): string {
  return model.displayName ?? model.name ?? model.id;
}

export function modelPickerDetail(input: {
  section: string;
  model: BrewvaSessionModelDescriptor;
  favorite: boolean;
}): string | undefined {
  if (input.section === "Favorites" || input.section === "Recent") {
    return providerDisplayName(input.model.provider);
  }
  return input.favorite ? "(Favorite)" : undefined;
}
