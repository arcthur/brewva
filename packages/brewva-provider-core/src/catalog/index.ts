import type { Api, KnownProvider, Model, Usage } from "../contracts/index.js";
import {
  isCodexEligibleModelId,
  modelSupportsXhigh,
  OPENAI_CODEX_PROVIDER,
  synthesizeCodexModel,
} from "../quirks/index.js";
import { MODELS } from "./models.generated.js";

// Retained as an extension hook for future provider/model deprecations.
const RETIRED_MODEL_KEYS = new Set<string>();

type ModelApi<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi }
  ? TApi extends Api
    ? TApi
    : never
  : never;

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

function isRetiredModel(provider: string, modelId: string): boolean {
  return RETIRED_MODEL_KEYS.has(modelKey(provider, modelId));
}

function getOpenAICodexModels(): Model<"openai-codex-responses">[] {
  const openAIModels = MODELS.openai as Record<string, Model<Api>>;
  return Object.values(openAIModels)
    .filter(
      (model) =>
        isCodexEligibleModelId(model.id) &&
        !isRetiredModel("openai", model.id) &&
        !isRetiredModel(OPENAI_CODEX_PROVIDER, model.id),
    )
    .map((model) => synthesizeCodexModel(model));
}

export function getModel(
  provider: "openai-codex",
  modelId: string,
): Model<"openai-codex-responses">;
export function getModel<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>>;
export function getModel(provider: KnownProvider, modelId: string): Model<Api> {
  if (provider === OPENAI_CODEX_PROVIDER) {
    return getOpenAICodexModels().find((model) => model.id === modelId) as Model<Api>;
  }

  const providerModels = MODELS[provider] as Record<string, Model<Api>> | undefined;
  if (isRetiredModel(provider, modelId)) {
    throw new Error(`Model "${modelKey(provider, modelId)}" is retired.`);
  }
  return providerModels?.[modelId] as Model<Api>;
}

export function getProviders(): KnownProvider[] {
  return Object.keys(MODELS) as KnownProvider[];
}

export function getModels(provider: "openai-codex"): Model<"openai-codex-responses">[];
export function getModels<TProvider extends KnownProvider>(
  provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[];
export function getModels(provider: KnownProvider): Model<Api>[] {
  if (provider === OPENAI_CODEX_PROVIDER) {
    return getOpenAICodexModels() as Model<Api>[];
  }

  const providerModels = MODELS[provider] as Record<string, Model<Api>> | undefined;
  return providerModels
    ? Object.values(providerModels).filter((model) => !isRetiredModel(model.provider, model.id))
    : [];
}

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1000000) * usage.input;
  usage.cost.output = (model.cost.output / 1000000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1000000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

export function supportsXhighModelId(modelId: string): boolean {
  return modelSupportsXhigh(modelId);
}

export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
  return modelSupportsXhigh(model.id);
}

export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.provider === b.provider;
}
