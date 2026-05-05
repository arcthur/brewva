import type { AssistantMessageEventStream } from "../utils/event-stream.js";
import type { Api, ThinkingBudgets, ThinkingLevel, Transport } from "./api.js";
import type {
  ProviderCacheCapability,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
} from "./cache.js";
import type { FileContent, ResolvedFileContent } from "./content.js";
import type { Model } from "./model.js";
import type { Context } from "./tool.js";

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
> = (model: Model<TApi>, context: Context, options?: TOptions) => AssistantMessageEventStream;
