import { MODELS } from "./models.generated.js";
import type { Api, KnownProvider, Model, Usage } from "./types.js";

type ModelApi<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi }
  ? TApi extends Api
    ? TApi
    : never
  : never;

export function getModel<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): Model<ModelApi<TProvider, TModelId>> {
  const providerModels = MODELS[provider] as Record<string, Model<Api>> | undefined;
  return providerModels?.[modelId as string] as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
  return Object.keys(MODELS) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
  provider: TProvider,
): Model<ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
  const providerModels = MODELS[provider] as Record<string, Model<Api>> | undefined;
  return providerModels
    ? (Object.values(providerModels) as Model<
        ModelApi<TProvider, keyof (typeof MODELS)[TProvider]>
      >[])
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
  if (modelId.includes("gpt-5.2") || modelId.includes("gpt-5.3") || modelId.includes("gpt-5.4")) {
    return true;
  }

  if (modelId.includes("opus-4-6") || modelId.includes("opus-4.6")) {
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
