import {
  BREWVA_THINKING_LEVELS,
  type BrewvaModelCatalog as ModelRegistry,
  type BrewvaThinkingLevel,
} from "@brewva/brewva-substrate/provider";

export type { BrewvaThinkingLevel };

type RegisteredModel = ReturnType<ModelRegistry["getAll"]>[number];

interface ModelMatchResult {
  model?: RegisteredModel;
  ambiguous?: RegisteredModel[];
}

function isValidThinkingLevel(value: string): value is BrewvaThinkingLevel {
  return BREWVA_THINKING_LEVELS.includes(value as BrewvaThinkingLevel);
}

function toModelKey(model: RegisteredModel): string {
  return `${model.provider}/${model.id}`;
}

function dedupeMatches(matches: RegisteredModel[]): RegisteredModel[] {
  const unique = new Map<string, RegisteredModel>();
  for (const model of matches) {
    unique.set(toModelKey(model), model);
  }
  return [...unique.values()];
}

function collectExactMatches(
  pattern: string,
  availableModels: RegisteredModel[],
): RegisteredModel[] {
  // A fully-qualified `provider/id` match is MORE SPECIFIC than a bare `id`
  // match, so it wins outright instead of tying. "deepseek/deepseek-v4-pro" must
  // resolve to the deepseek-provider model whose qualified name IS the pattern,
  // not go ambiguous against an aggregator whose bare id happens to equal the
  // pattern (its qualified name is "openrouter/deepseek/deepseek-v4-pro"). A
  // qualified name is unique, so this yields at most one match. Only when NO
  // qualified match exists do bare-id matches apply — and there a genuine
  // cross-provider id collision still, correctly, surfaces as ambiguous.
  const qualified = dedupeMatches(
    availableModels.filter((model) => `${model.provider}/${model.id}` === pattern),
  );
  if (qualified.length > 0) {
    return qualified;
  }
  return dedupeMatches(availableModels.filter((model) => model.id === pattern));
}

function toMatchResult(matches: RegisteredModel[]): ModelMatchResult {
  if (matches.length === 1) {
    return { model: matches[0] };
  }
  if (matches.length > 1) {
    return {
      ambiguous: matches.toSorted((left, right) =>
        toModelKey(left).localeCompare(toModelKey(right)),
      ),
    };
  }
  return {};
}

function parseModelPattern(
  pattern: string,
  availableModels: RegisteredModel[],
): ModelMatchResult & { thinkingLevel?: BrewvaThinkingLevel } {
  const directMatch = toMatchResult(collectExactMatches(pattern, availableModels));
  if (directMatch.model || directMatch.ambiguous) {
    return directMatch;
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

  const resolved = toMatchResult(collectExactMatches(prefix, availableModels));
  if (!resolved.model || resolved.ambiguous) {
    return resolved;
  }
  return {
    model: resolved.model,
    thinkingLevel: suffix,
  };
}

export interface BrewvaModelSelection {
  model?: RegisteredModel;
  thinkingLevel?: BrewvaThinkingLevel;
}

function formatAmbiguousModelError(pattern: string, matches: RegisteredModel[]): Error {
  const candidates = matches.map((model) => toModelKey(model)).join(", ");
  return new Error(`Model "${pattern}" is ambiguous. Candidates: ${candidates}`);
}

export function resolveBrewvaModelSelection(
  modelText: string | undefined,
  registry: Pick<ModelRegistry, "getAll">,
): BrewvaModelSelection {
  const normalized = modelText?.trim();
  if (!normalized) {
    return {};
  }

  const availableModels = registry.getAll();
  if (availableModels.length === 0) {
    throw new Error("No models are available in the Brewva model registry.");
  }

  const resolved = parseModelPattern(normalized, availableModels);
  if (resolved.ambiguous) {
    throw formatAmbiguousModelError(normalized, resolved.ambiguous);
  }
  if (resolved.model) {
    return resolved;
  }
  throw new Error(`Model "${normalized}" was not found in the configured Brewva model registry.`);
}
