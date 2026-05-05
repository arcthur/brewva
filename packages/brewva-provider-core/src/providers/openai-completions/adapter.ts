import OpenAI from "openai";
import {
  resolveOpenAICompletionsCacheRender,
  type OpenAICompletionsCacheRender,
} from "../../cache/render/openai-completions.js";
import { supportsXhigh } from "../../catalog/index.js";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  ResolvedOpenAICompletionsCompat,
  SimpleStreamOptions,
  StreamFunction,
} from "../../contracts/index.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { asPartialObject } from "../../utils/unknown-object.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
} from "../_shared/github-copilot-headers.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import { buildBaseOptions, clampReasoning } from "../_shared/simple-options.js";
import { resolveOpenAICompletionsCompat } from "./compat.js";
import type { OpenAICompletionsOptions } from "./contract.js";
import { buildOpenAICompletionsParams } from "./request.js";
import { processOpenAICompletionsStream } from "./stream-events.js";
import {
  asStreamingParams,
  readErrorRawMetadata,
  type OpenAICompletionsRequestCompat,
} from "./wire.js";

function createClient(
  model: Model<"openai-completions">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  cacheRender?: OpenAICompletionsCacheRender,
  compat = resolveOpenAICompletionsCompat(model),
  sessionId?: string,
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const headers = buildOpenAICompletionsDefaultHeaders(
    model,
    context,
    cacheRender,
    optionsHeaders,
    compat,
    sessionId,
  );

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
      const apiKey = options?.apiKey || "";
      const compat = resolveOpenAICompletionsCompat(model);
      const cacheRender = resolveOpenAICompletionsCacheRender({
        provider: model.provider,
        modelId: model.id,
        baseUrl: model.baseUrl,
        sessionId: options?.sessionId,
        policy: options?.cachePolicy,
        transport: options?.transport,
        cacheControlFormat: compat.cacheControlFormat,
        supportsPromptCacheKey: compat.supportsPromptCacheKey,
        supportsLongCacheRetention: compat.supportsLongCacheRetention,
      });
      const client = createClient(
        model,
        context,
        apiKey,
        options?.headers,
        cacheRender,
        compat,
        options?.sessionId,
      );
      void options?.onCacheRender?.(cacheRender, model);
      let params: OpenAICompletionsRequestCompat = buildOpenAICompletionsParams(
        model,
        context,
        options,
        cacheRender,
      );
      const nextParams = await options?.onPayload?.(
        params,
        model,
        buildProviderPayloadMetadata(model, options, params, cacheRender),
      );
      if (nextParams !== undefined) {
        const payloadOverride = asPartialObject<OpenAICompletionsRequestCompat>(nextParams) ?? {};
        params = {
          ...params,
          ...payloadOverride,
          stream: true,
        };
      }
      const openaiStream = await client.chat.completions.create(asStreamingParams(params), {
        signal: options?.signal,
      });
      ensureStarted();
      try {
        await processOpenAICompletionsStream(
          openaiStream,
          output,
          stream,
          model,
          composer.toolCalls,
        );
      } catch (error) {
        const rawMetadata = readErrorRawMetadata(error);
        if (rawMetadata) {
          throw new Error(
            `${error instanceof Error ? error.message : JSON.stringify(error)}\n${rawMetadata}`,
          );
        }
        throw error;
      }
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
    },
    {
      signal: options?.signal,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (
  model: Model<"openai-completions">,
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
  const toolChoice = (options as OpenAICompletionsOptions | undefined)?.toolChoice;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
  } satisfies OpenAICompletionsOptions);
};

export function buildOpenAICompletionsDefaultHeaders(
  model: Model<"openai-completions">,
  context: Context,
  cacheRender?: OpenAICompletionsCacheRender,
  optionsHeaders?: Record<string, string>,
  compat: ResolvedOpenAICompletionsCompat = resolveOpenAICompletionsCompat(model),
  sessionId?: string,
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

  const cacheAffinitySessionId = resolveCompletionsCacheAffinitySessionId(cacheRender, sessionId);
  if (compat.sendSessionAffinityHeaders && cacheAffinitySessionId) {
    headers.session_id = cacheAffinitySessionId;
    headers["x-client-request-id"] = cacheAffinitySessionId;
    headers["x-session-affinity"] = cacheAffinitySessionId;
  }

  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return headers;
}

function resolveCompletionsCacheAffinitySessionId(
  cacheRender: OpenAICompletionsCacheRender | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!cacheRender || (cacheRender.status !== "rendered" && cacheRender.status !== "degraded")) {
    return undefined;
  }
  return cacheRender.promptCacheKey ?? sessionId;
}
