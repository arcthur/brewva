import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { GoogleGenAI } from "@google/genai";
import { resolveGoogleGenAICacheRender } from "../../cache/render/google-genai.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../../contracts/index.js";
import { providerTryPromise } from "../../stream/effect-interop.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import {
  getGoogleThinkingLevel,
  isGemini3Model,
  resolveThinkingBudget,
} from "../_shared/google/thinking.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import { buildBaseOptions, clampReasoning } from "../_shared/simple-options.js";
import type { GoogleGenAIClient, GoogleGenAIOptions } from "./contract.js";
import { buildGoogleGenAIRequest } from "./request.js";
import { processGoogleGenAIStream } from "./stream-events.js";

function createGoogleGenAIClient(options: GoogleGenAIOptions = {}): GoogleGenAIClient {
  if (options.client) {
    return options.client;
  }
  if (!options.apiKey && !options.enterprise && !options.googleAuthOptions) {
    throw new Error("Google GenAI requires an API key or Google application credentials.");
  }
  return new GoogleGenAI({
    apiKey: options.apiKey,
    enterprise: options.enterprise,
    project: options.project,
    location: options.location,
    apiVersion: options.apiVersion,
    googleAuthOptions: options.googleAuthOptions,
    httpOptions: options.httpOptions,
  }) as GoogleGenAIClient;
}

export const streamGoogleGenAI: StreamFunction<"google-genai", GoogleGenAIOptions> = (
  model: Model<"google-genai">,
  context: Context,
  options?: GoogleGenAIOptions,
) => {
  return runProviderStream(
    model,
    ({ stream, output, ensureStarted, composer, signal }) =>
      BrewvaEffect.gen(function* () {
        const client = yield* providerTryPromise(async () => createGoogleGenAIClient(options));
        const requestOptions = { ...options, signal } satisfies GoogleGenAIOptions;
        const cacheRender = resolveGoogleGenAICacheRender({
          cachedContentName: options?.cacheControl?.cachedContent?.name,
          cachedContentTtlSeconds: options?.cacheControl?.cachedContent?.ttlSeconds,
          modelId: model.id,
          policy: options?.cachePolicy,
          sessionId: options?.sessionId,
        });
        yield* providerTryPromise(async () => options?.onCacheRender?.(cacheRender, model));
        let request = buildGoogleGenAIRequest(model, context, requestOptions);
        const nextRequest = yield* providerTryPromise(async () =>
          options?.onPayload?.(
            request,
            model,
            buildProviderPayloadMetadata(model, requestOptions, request, cacheRender),
          ),
        );
        if (nextRequest !== undefined) {
          request = nextRequest as typeof request;
        }

        const response = yield* providerTryPromise(async () =>
          client.models.generateContentStream(request),
        );
        yield* ensureStarted();
        yield* processGoogleGenAIStream(response, output, stream, model, composer.toolCalls);
      }),
    {
      signal: options?.signal,
      sessionId: options?.sessionId,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleGoogleGenAI: StreamFunction<"google-genai", SimpleStreamOptions> = (
  model: Model<"google-genai">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = {
    ...buildBaseOptions(model, options, apiKey),
    maxTokens: options?.maxTokens ?? model.maxTokens / 3,
  };
  const googleOptions = options as Partial<GoogleGenAIOptions> | undefined;
  const baseMaxTokens = base.maxTokens ?? model.maxTokens / 3;
  if (!options?.reasoning) {
    return streamGoogleGenAI(model, context, {
      ...base,
      client: googleOptions?.client,
      maxTokens: baseMaxTokens,
      thinking: { enabled: false },
    });
  }
  const reasoning = clampReasoning(options.reasoning)!;
  if (isGemini3Model(model.id)) {
    return streamGoogleGenAI(model, context, {
      ...base,
      client: googleOptions?.client,
      maxTokens: baseMaxTokens,
      thinking: {
        enabled: true,
        level: getGoogleThinkingLevel(reasoning, model.id),
      },
    });
  }
  const adjusted = resolveThinkingBudget(
    baseMaxTokens,
    model.maxTokens,
    reasoning,
    options.thinkingBudgets,
  );
  return streamGoogleGenAI(model, context, {
    ...base,
    client: googleOptions?.client,
    maxTokens: adjusted.maxTokens,
    thinking: {
      enabled: true,
      budgetTokens: adjusted.thinkingBudget,
    },
  });
};
