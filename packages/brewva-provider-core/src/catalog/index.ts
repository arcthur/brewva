import type { Api, KnownProvider, Model, Usage } from "../contracts/index.js";
import { MODELS } from "./models.generated.js";

// Retained as an extension hook for future provider/model deprecations.
const RETIRED_MODEL_KEYS = new Set<string>();
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const OPENAI_CODEX_ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
const OPENAI_CODEX_LEGACY_MODEL_IDS = new Set([
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

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

function isGptModelAfter54(modelId: string): boolean {
  const match = /^gpt-(\d+)\.(\d+)(?:$|[-_])/u.exec(modelId);
  if (!match) {
    return false;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  return major > 5 || (major === 5 && minor > 4);
}

function isOpenAICodexModelId(modelId: string): boolean {
  return OPENAI_CODEX_LEGACY_MODEL_IDS.has(modelId) || isGptModelAfter54(modelId);
}

function toOpenAICodexModel(model: Model<Api>): Model<"openai-codex-responses"> {
  return {
    id: model.id,
    name: model.name,
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    baseUrl: OPENAI_CODEX_BASE_URL,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...OPENAI_CODEX_ZERO_COST },
    contextWindow: model.id.includes("gpt-5.5") ? 400_000 : model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function getOpenAICodexModels(): Model<"openai-codex-responses">[] {
  const openAIModels = MODELS.openai as Record<string, Model<Api>>;
  return Object.values(openAIModels)
    .filter(
      (model) =>
        isOpenAICodexModelId(model.id) &&
        !isRetiredModel("openai", model.id) &&
        !isRetiredModel(OPENAI_CODEX_PROVIDER, model.id),
    )
    .map((model) => toOpenAICodexModel(model));
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
  if (
    modelId.includes("gpt-5.2") ||
    modelId.includes("gpt-5.3") ||
    modelId.includes("gpt-5.4") ||
    modelId.includes("gpt-5.5")
  ) {
    return true;
  }

  if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) {
    return true;
  }

  if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro") {
    return true;
  }

  return false;
}

export function supportsXhigh<TApi extends Api>(model: Model<TApi>): boolean {
  return supportsXhighModelId(model.id);
}

export function modelsAreEqual<TApi extends Api>(
  a: Model<TApi> | null | undefined,
  b: Model<TApi> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.provider === b.provider;
}
