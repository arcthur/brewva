import type Anthropic from "@anthropic-ai/sdk";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { asPartialObject } from "@brewva/brewva-std/unknown";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../../contracts/index.js";
import { failProviderStream, providerTryPromise } from "../../stream/effect-interop.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { buildProviderPayloadMetadata } from "../_shared/payload-metadata.js";
import { adjustMaxTokensForThinking, buildBaseOptions } from "../_shared/simple-options.js";
import { mapThinkingLevelToEffort, supportsAdaptiveThinking } from "./compat.js";
import type { AnthropicOptions } from "./contract.js";
import {
  buildAnthropicParams,
  createAnthropicClient,
  resolveCopilotDynamicHeaders,
} from "./request.js";
import { processAnthropicStream } from "./stream-events.js";

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: AnthropicOptions,
) => {
  return runProviderStream(
    model,
    ({ stream, output, ensureStarted, composer, signal }) =>
      BrewvaEffect.gen(function* () {
        let client: Anthropic;
        let oauthToken: boolean;
        let requestHeaders: Record<string, string> | undefined;

        if (options?.client) {
          client = options.client;
          oauthToken = false;
          requestHeaders = options.headers;
        } else {
          const apiKey = options?.apiKey ?? "";
          const copilotDynamicHeaders = resolveCopilotDynamicHeaders(model, context);
          const created = createAnthropicClient(
            model,
            apiKey,
            options?.interleavedThinking ?? true,
            options?.headers,
            copilotDynamicHeaders,
          );
          client = created.client;
          oauthToken = created.isOAuthToken;
          requestHeaders = created.headers;
        }
        let params = buildAnthropicParams(model, context, oauthToken, options);
        const nextParams = yield* providerTryPromise(async () =>
          options?.onPayload?.(
            params,
            model,
            buildProviderPayloadMetadata(model, options, params, undefined, {
              headers: requestHeaders,
            }),
          ),
        );
        if (nextParams !== undefined) {
          params = {
            ...params,
            ...asPartialObject<typeof params>(nextParams),
          };
        }
        const anthropicStream = client.messages.stream({ ...params, stream: true }, { signal });
        yield* ensureStarted();
        yield* processAnthropicStream(anthropicStream, output, stream, model, composer.toolCalls, {
          isOAuth: oauthToken,
          tools: context.tools,
        });
        if (signal.aborted) {
          return yield* failProviderStream("Request was aborted");
        }
        if (output.stopReason === "aborted" || output.stopReason === "error") {
          return yield* failProviderStream(output.errorMessage || "An unknown error occurred");
        }
      }),
    {
      signal: options?.signal,
      sessionId: options?.sessionId,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  if (!options?.reasoning) {
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: false,
    } satisfies AnthropicOptions);
  }

  if (supportsAdaptiveThinking(model.id)) {
    const effort = mapThinkingLevelToEffort(options.reasoning, model.id);
    return streamAnthropic(model, context, {
      ...base,
      thinkingEnabled: true,
      effort,
    } satisfies AnthropicOptions);
  }

  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens || 0,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  );

  return streamAnthropic(model, context, {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  } satisfies AnthropicOptions);
};
