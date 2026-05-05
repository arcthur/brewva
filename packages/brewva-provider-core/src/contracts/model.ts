import type { Api, Provider, ThinkingLevel } from "./api.js";

export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Partial<Record<ThinkingLevel, string>>;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "qwen" | "qwen-chat-template" | "deepseek";
  openRouterRouting?: OpenRouterRouting;
  supportsStrictMode?: boolean;
  cacheControlFormat?: "anthropic" | "none";
  supportsPromptCacheKey?: boolean;
  sendSessionAffinityHeaders?: boolean;
  supportsLongCacheRetention?: boolean;
}

export type ResolvedOpenAICompletionsCompat = Required<
  Omit<
    OpenAICompletionsCompat,
    "cacheControlFormat" | "supportsPromptCacheKey" | "supportsLongCacheRetention"
  >
> &
  Pick<
    OpenAICompletionsCompat,
    "cacheControlFormat" | "supportsPromptCacheKey" | "supportsLongCacheRetention"
  >;

export interface OpenAIResponsesCompat {
  sendSessionIdHeader?: boolean;
}

export interface OpenRouterRouting {
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "deny" | "allow";
  zdr?: boolean;
  enforce_distillable_text?: boolean;
  order?: string[];
  only?: string[];
  ignore?: string[];
  quantizations?: string[];
  sort?:
    | string
    | {
        by?: string;
        partition?: string | null;
      };
  max_price?: {
    prompt?: number | string;
    completion?: number | string;
    image?: number | string;
    audio?: number | string;
    request?: number | string;
  };
  preferred_min_throughput?:
    | number
    | {
        p50?: number;
        p75?: number;
        p90?: number;
        p99?: number;
      };
  preferred_max_latency?:
    | number
    | {
        p50?: number;
        p75?: number;
        p90?: number;
        p99?: number;
      };
}

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : never;
}
