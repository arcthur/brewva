import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { resolveOpenAIResponsesCacheRender } from "../cache-policy.js";
import { supportsXhigh } from "../models.js";
import { runProviderStream } from "../streaming/stream-runner.js";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  Usage,
} from "../types.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.js";
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from "./openai-responses-shared.js";
import { buildProviderPayloadMetadata } from "./payload-metadata.js";
import { buildBaseOptions, clampReasoning } from "./simple-options.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise" | null;
  serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
      // Create OpenAI client
      const apiKey = options?.apiKey || "";
      const client = createClient(model, context, apiKey, options?.headers);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(
        params,
        model,
        buildProviderPayloadMetadata(model, options, params),
      );
      if (nextParams !== undefined) {
        params = nextParams as ResponseCreateParamsStreaming;
      }
      const openaiStream = await client.responses.create(
        params,
        options?.signal ? { signal: options.signal } : undefined,
      );
      ensureStarted();

      await processResponsesStream(openaiStream, output, stream, model, composer.toolCalls, {
        serviceTier: options?.serviceTier,
        applyServiceTierPricing,
      });

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
    },
    {
      signal: options?.signal,
      tools: context.tools,
    },
  );
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);

  return streamOpenAIResponses(model, context, {
    ...base,
    reasoningEffort,
  } satisfies OpenAIResponsesOptions);
};

function createClient(
  model: Model<"openai-responses">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const headers = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  // Merge options headers last so they can override defaults
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}

function buildParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) {
  const messages = convertResponsesMessages(
    model,
    context,
    OPENAI_TOOL_CALL_PROVIDERS,
    undefined,
    options,
  );

  const cacheRender = resolveOpenAIResponsesCacheRender({
    api: "openai-responses",
    baseUrl: model.baseUrl,
    provider: model.provider,
    modelId: model.id,
    transport: options?.transport,
    sessionId: options?.sessionId,
    policy: options?.cachePolicy,
  });
  void options?.onCacheRender?.(cacheRender, model);
  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    store: false,
    ...(cacheRender.promptCacheKey ? { prompt_cache_key: cacheRender.promptCacheKey } : {}),
    ...(cacheRender.promptCacheRetention
      ? { prompt_cache_retention: cacheRender.promptCacheRetention }
      : {}),
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options?.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options?.temperature;
  }

  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }

  if (context.tools) {
    params.tools = convertResponsesTools(context.tools);
  }

  if (model.reasoning) {
    if (options?.reasoningEffort || options?.reasoningSummary) {
      params.reasoning = {
        effort: options?.reasoningEffort || "medium",
        summary: options?.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot") {
      params.reasoning = { effort: "none" };
    }
  }

  return params;
}

function getServiceTierCostMultiplier(
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
  switch (serviceTier) {
    case "flex":
      return 0.5;
    case "priority":
      return 2;
    default:
      return 1;
  }
}

function applyServiceTierPricing(
  usage: Usage,
  serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
) {
  const multiplier = getServiceTierCostMultiplier(serviceTier);
  if (multiplier === 1) return;

  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
