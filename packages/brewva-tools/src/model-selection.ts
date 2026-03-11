import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type BrewvaThinkingLevel = (typeof VALID_THINKING_LEVELS)[number];

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

function isAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !/-\d{8}$/u.test(id);
}

function isValidThinkingLevel(value: string): value is BrewvaThinkingLevel {
  return VALID_THINKING_LEVELS.includes(value as BrewvaThinkingLevel);
}

function tryMatchModel(
  pattern: string,
  availableModels: RegisteredModel[],
): RegisteredModel | undefined {
  const slashIndex = pattern.indexOf("/");
  if (slashIndex !== -1) {
    const provider = pattern.substring(0, slashIndex);
    const modelId = pattern.substring(slashIndex + 1);
    const providerMatch = availableModels.find(
      (model) =>
        model.provider.toLowerCase() === provider.toLowerCase() &&
        model.id.toLowerCase() === modelId.toLowerCase(),
    );
    if (providerMatch) return providerMatch;
  }

  const exactMatch = availableModels.find(
    (model) => model.id.toLowerCase() === pattern.toLowerCase(),
  );
  if (exactMatch) return exactMatch;

  const matches = availableModels.filter(
    (model) =>
      model.id.toLowerCase().includes(pattern.toLowerCase()) ||
      model.name?.toLowerCase().includes(pattern.toLowerCase()),
  );
  if (matches.length === 0) return undefined;

  const aliases = matches.filter((model) => isAlias(model.id));
  const datedVersions = matches.filter((model) => !isAlias(model.id));
  const ranked = aliases.length > 0 ? aliases : datedVersions;

  ranked.sort((left, right) => right.id.localeCompare(left.id));
  return ranked[0];
}

function parseModelPattern(
  pattern: string,
  availableModels: RegisteredModel[],
): { model: RegisteredModel | undefined; thinkingLevel?: BrewvaThinkingLevel } {
  const exactMatch = tryMatchModel(pattern, availableModels);
  if (exactMatch) {
    return { model: exactMatch };
  }

  const lastColonIndex = pattern.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return { model: undefined };
  }

  const prefix = pattern.substring(0, lastColonIndex);
  const suffix = pattern.substring(lastColonIndex + 1);
  if (!isValidThinkingLevel(suffix)) {
    return { model: undefined };
  }

  const resolved = parseModelPattern(prefix, availableModels);
  if (!resolved.model) {
    return resolved;
  }
  return {
    model: resolved.model,
    thinkingLevel: suffix,
  };
}

function findExactModel(
  pattern: string,
  availableModels: RegisteredModel[],
): RegisteredModel | undefined {
  const lowered = pattern.toLowerCase();
  return availableModels.find(
    (model) =>
      model.id.toLowerCase() === lowered ||
      `${model.provider}/${model.id}`.toLowerCase() === lowered,
  );
}

export interface BrewvaModelSelection {
  model?: RegisteredModel;
  thinkingLevel?: BrewvaThinkingLevel;
}

export function resolveBrewvaModelSelection(
  modelText: string | undefined,
  registry: ModelRegistry,
): BrewvaModelSelection {
  const normalized = modelText?.trim();
  if (!normalized) {
    return {};
  }

  const availableModels = registry.getAll();
  if (availableModels.length === 0) {
    throw new Error("No models are available in the Brewva model registry.");
  }

  const providerMap = new Map<string, string>();
  for (const model of availableModels) {
    providerMap.set(model.provider.toLowerCase(), model.provider);
  }

  let provider: string | undefined;
  let pattern = normalized;
  let inferredProvider = false;

  const slashIndex = normalized.indexOf("/");
  if (slashIndex !== -1) {
    const maybeProvider = normalized.substring(0, slashIndex);
    const canonicalProvider = providerMap.get(maybeProvider.toLowerCase());
    if (canonicalProvider) {
      provider = canonicalProvider;
      pattern = normalized.substring(slashIndex + 1);
      inferredProvider = true;
    }
  }

  if (!provider) {
    const exact = findExactModel(normalized, availableModels);
    if (exact) {
      return { model: exact };
    }
  }

  const candidates = provider
    ? availableModels.filter((model) => model.provider === provider)
    : availableModels;
  const resolved = parseModelPattern(pattern, candidates);
  if (resolved.model) {
    return resolved;
  }

  if (inferredProvider) {
    const exact = findExactModel(normalized, availableModels);
    if (exact) {
      return { model: exact };
    }

    const fallback = parseModelPattern(normalized, availableModels);
    if (fallback.model) {
      return fallback;
    }
  }

  const display = provider ? `${provider}/${pattern}` : normalized;
  throw new Error(`Model "${display}" was not found in the configured Brewva model registry.`);
}
