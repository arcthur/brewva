import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import {
  resolveOpenAIResponsesCacheRender,
  type OpenAIResponsesCacheRender,
} from "../../cache/render/openai-responses.js";
import { supportsXhigh } from "../../catalog/index.js";
import type {
  Context,
  Model,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
  StreamFunction,
} from "../../contracts/index.js";
import { failProviderStream, providerTryPromise } from "../../stream/effect-interop.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../_shared/github-copilot-headers.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import { buildBaseOptions, clampReasoning } from "../_shared/simple-options.js";
import type { OpenAIResponsesOptions } from "./contract.js";
import { buildOpenAIResponsesParams } from "./request.js";
import { processResponsesStream } from "./stream-events.js";
import { applyServiceTierPricing } from "./usage.js";

export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
  model: Model<"openai-responses">,
  context: Context,
  options?: OpenAIResponsesOptions,
) => {
  return runProviderStream(
    model,
    ({ stream, output, ensureStarted, composer, signal }) =>
      BrewvaEffect.gen(function* () {
        const apiKey = options?.apiKey || "";
        const compat = resolveOpenAIResponsesCompat(model);
        const cacheRender = resolveOpenAIResponsesCacheRender({
          api: "openai-responses",
          baseUrl: model.baseUrl,
          provider: model.provider,
          modelId: model.id,
          transport: options?.transport,
          sessionId: options?.sessionId,
          policy: options?.cachePolicy,
        });
        const client = createClient(model, context, apiKey, options?.headers, cacheRender, compat);
        let params = buildOpenAIResponsesParams(model, context, options, cacheRender);
        const nextParams = yield* providerTryPromise(async () =>
          options?.onPayload?.(
            params,
            model,
            buildProviderPayloadMetadata(model, options, params, cacheRender),
          ),
        );
        if (nextParams !== undefined) {
          params = nextParams as ResponseCreateParamsStreaming;
        }
        const openaiStream = yield* providerTryPromise(() =>
          client.responses.create(params, { signal }),
        );
        yield* ensureStarted();

        yield* processResponsesStream(openaiStream, output, stream, model, composer.toolCalls, {
          serviceTier: options?.serviceTier,
          applyServiceTierPricing,
        });

        if (output.stopReason === "aborted" || output.stopReason === "error") {
          return yield* failProviderStream("An unknown error occurred");
        }
      }),
    {
      signal: options?.signal,
      sessionId: options?.sessionId,
      tools: context.tools,
    },
  );
};

export const streamSimpleOpenAIResponses: StreamFunction<
  "openai-responses",
  SimpleStreamOptions
> = (model: Model<"openai-responses">, context: Context, options?: SimpleStreamOptions) => {
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
  cacheRender?: OpenAIResponsesCacheRender,
  compat = resolveOpenAIResponsesCompat(model),
): OpenAI {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const headers = buildOpenAIResponsesDefaultHeaders(
    model,
    context,
    cacheRender,
    optionsHeaders,
    compat,
  );

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}

export function resolveOpenAIResponsesCompat(
  model: Model<"openai-responses">,
): Required<OpenAIResponsesCompat> {
  return {
    sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
  };
}

export function buildOpenAIResponsesDefaultHeaders(
  model: Model<"openai-responses">,
  context: Context,
  cacheRender?: OpenAIResponsesCacheRender,
  optionsHeaders?: Record<string, string>,
  compat: Required<OpenAIResponsesCompat> = resolveOpenAIResponsesCompat(model),
): Record<string, string> {
  const headers: Record<string, string> = { ...model.headers };
  if (model.provider === "github-copilot") {
    const hasImages = hasCopilotVisionInput(context.messages);
    const copilotHeaders = buildCopilotDynamicHeaders({
      messages: context.messages,
      hasImages,
    });
    Object.assign(headers, copilotHeaders);
  }

  if (cacheRender?.promptCacheKey) {
    if (compat.sendSessionIdHeader) {
      headers.session_id = cacheRender.promptCacheKey;
    }
    headers["x-client-request-id"] = cacheRender.promptCacheKey;
  }

  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return headers;
}
