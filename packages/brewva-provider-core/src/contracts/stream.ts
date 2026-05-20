import { BrewvaConfigService } from "@brewva/brewva-effect";
import {
  BrewvaConfig,
  BrewvaContext,
  BrewvaEffect,
  BrewvaLayer,
  BrewvaSchema,
  BrewvaStream,
} from "@brewva/brewva-effect/primitives";
import type { Api, ThinkingBudgets, ThinkingLevel, Transport } from "./api.js";
import type {
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
} from "./cache.js";
import type { FileContent, ResolvedFileContent } from "./content.js";
import type { AssistantMessageEvent } from "./event.js";
import type { Model } from "./model.js";
import type { Context } from "./tool.js";

export interface ProviderRuntimeService {
  readonly streamBufferSize: number;
}

export class ProviderRuntime extends BrewvaContext.Service<
  ProviderRuntime,
  ProviderRuntimeService
>()("@brewva/brewva-provider-core/ProviderRuntime") {}

export class ProviderRuntimeConfig extends BrewvaConfigService.Service<ProviderRuntimeConfig>()(
  "@brewva/brewva-provider-core/ProviderRuntimeConfig",
  {
    streamBufferSize: BrewvaConfig.int("BREWVA_PROVIDER_STREAM_BUFFER_SIZE").pipe(
      BrewvaConfig.withDefault(64),
      BrewvaConfig.map((value) => Math.max(1, value)),
    ),
  },
) {}

export function providerRuntimeLayerFrom(
  service: ProviderRuntimeService,
): BrewvaLayer.Layer<ProviderRuntime> {
  return BrewvaLayer.succeed(ProviderRuntime)(service);
}

export const providerRuntimeLayer = BrewvaLayer.effect(
  ProviderRuntime,
  BrewvaEffect.gen(function* () {
    const config = yield* ProviderRuntimeConfig;
    return ProviderRuntime.of({
      streamBufferSize: config.streamBufferSize,
    });
  }),
).pipe(BrewvaLayer.provide(ProviderRuntimeConfig.defaultLayer));

export class ProviderStreamError extends BrewvaSchema.TaggedErrorClass<ProviderStreamError>()(
  "ProviderStreamError",
  {
    message: BrewvaSchema.String,
    cause: BrewvaSchema.optional(BrewvaSchema.Unknown),
  },
) {}

export type ProviderAssistantMessageStream = BrewvaStream.Stream<
  AssistantMessageEvent,
  ProviderStreamError,
  ProviderRuntime
>;

export interface ProviderEventSink {
  push(event: AssistantMessageEvent): Promise<void>;
  end(): Promise<void>;
}

export interface ProviderPayloadMetadata {
  cachePolicy?: ProviderCachePolicy;
  cacheRender?: ProviderCacheRenderResult;
  cacheCapability?: ProviderCacheCapability;
  reasoning?: unknown;
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  headers?: Record<string, string>;
  extraBody?: unknown;
  providerFallback?: unknown;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  cachePolicy?: ProviderCachePolicy;
  onCacheRender?: (render: ProviderCacheRenderResult, model: Model<Api>) => void | Promise<void>;
  sessionId?: string;
  onPayload?: (
    payload: unknown,
    model: Model<Api>,
    metadata?: ProviderPayloadMetadata,
  ) => unknown | undefined | Promise<unknown | undefined>;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
  resolveFile?: (part: FileContent, model: Model<Api>) => ResolvedFileContent | undefined;
}

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: ThinkingBudgets;
}

export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (model: Model<TApi>, context: Context, options?: TOptions) => ProviderAssistantMessageStream;
