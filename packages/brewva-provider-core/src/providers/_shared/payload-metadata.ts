import { resolveProviderCacheCapability } from "../../cache/capability.js";
import type {
  Api,
  Model,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  StreamOptions,
  ThinkingBudgets,
  Transport,
} from "../../contracts/index.js";

type PayloadMetadataOptions = StreamOptions & {
  reasoning?: unknown;
  reasoningEffort?: unknown;
  effort?: unknown;
  thinkingBudgetTokens?: unknown;
  thinkingBudgets?: ThinkingBudgets;
};

export function buildProviderPayloadMetadata(
  model: Model<Api>,
  options: PayloadMetadataOptions | undefined,
  payload: unknown,
  cacheRender?: ProviderCacheRenderResult,
  overrides: Partial<ProviderPayloadMetadata> = {},
): ProviderPayloadMetadata {
  const reasoning = [
    options?.reasoning,
    options?.reasoningEffort,
    options?.effort,
    options?.thinkingBudgetTokens,
  ].find((value) => value !== undefined);
  return {
    cachePolicy: overrides.cachePolicy ?? options?.cachePolicy,
    cacheRender: overrides.cacheRender ?? cacheRender,
    cacheCapability:
      overrides.cacheCapability ??
      cacheRender?.capability ??
      resolveProviderCacheCapability({
        api: model.api,
        provider: model.provider,
        modelId: model.id,
        baseUrl: model.baseUrl,
        transport: options?.transport as Transport | undefined,
      }),
    reasoning: overrides.reasoning ?? reasoning,
    thinkingBudgets: overrides.thinkingBudgets ?? options?.thinkingBudgets,
    transport: overrides.transport ?? (options?.transport as Transport | undefined),
    headers: overrides.headers ?? mergeMetadataHeaders(model.headers, options?.headers),
    extraBody: overrides.extraBody ?? payload,
    providerFallback: overrides.providerFallback ??
      options?.metadata?.providerFallback ?? {
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl,
      },
  };
}

function mergeMetadataHeaders(
  modelHeaders: Record<string, string> | undefined,
  optionHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = {
    ...(modelHeaders ?? {}),
    ...(optionHeaders ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
