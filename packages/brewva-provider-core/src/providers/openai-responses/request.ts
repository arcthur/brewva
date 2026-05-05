import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
  resolveOpenAIResponsesCacheRender,
  type OpenAIResponsesCacheRender,
} from "../../cache/render/openai-responses.js";
import type { Context, Model } from "../../contracts/index.js";
import type { OpenAIResponsesOptions } from "./contract.js";
import { convertResponsesMessages } from "./messages.js";
import { convertResponsesTools } from "./tools.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex"]);

export function buildOpenAIResponsesParams(
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
  cacheRender?: OpenAIResponsesCacheRender,
): ResponseCreateParamsStreaming {
  const messages = convertResponsesMessages(
    model,
    context,
    OPENAI_TOOL_CALL_PROVIDERS,
    undefined,
    options,
  );

  const resolvedCacheRender =
    cacheRender ??
    resolveOpenAIResponsesCacheRender({
      api: "openai-responses",
      baseUrl: model.baseUrl,
      provider: model.provider,
      modelId: model.id,
      transport: options?.transport,
      sessionId: options?.sessionId,
      policy: options?.cachePolicy,
    });
  void options?.onCacheRender?.(resolvedCacheRender, model);

  const params: ResponseCreateParamsStreaming = {
    model: model.id,
    input: messages,
    stream: true,
    store: false,
    ...(resolvedCacheRender.promptCacheKey
      ? { prompt_cache_key: resolvedCacheRender.promptCacheKey }
      : {}),
    ...(resolvedCacheRender.promptCacheRetention
      ? { prompt_cache_retention: resolvedCacheRender.promptCacheRetention }
      : {}),
  };

  if (options?.maxTokens) {
    params.max_output_tokens = options.maxTokens;
  }

  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
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
        effort: options.reasoningEffort || "medium",
        summary: options.reasoningSummary || "auto",
      };
      params.include = ["reasoning.encrypted_content"];
    } else if (model.provider !== "github-copilot") {
      params.reasoning = { effort: "none" };
    }
  }

  return params;
}
