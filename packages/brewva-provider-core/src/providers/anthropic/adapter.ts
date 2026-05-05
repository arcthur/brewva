import type Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from "../../contracts/index.js";
import { runProviderStream } from "../../stream/run-provider-stream.js";
import { asPartialObject } from "../../utils/unknown-object.js";
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
): AssistantMessageEventStream => {
  return runProviderStream(
    model,
    async ({ stream, output, ensureStarted, composer }) => {
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
      const nextParams = await options?.onPayload?.(
        params,
        model,
        buildProviderPayloadMetadata(model, options, params, undefined, {
          headers: requestHeaders,
        }),
      );
      if (nextParams !== undefined) {
        params = {
          ...params,
          ...asPartialObject<typeof params>(nextParams),
        };
      }
      const anthropicStream = client.messages.stream(
        { ...params, stream: true },
        { signal: options?.signal },
      );
      ensureStarted();
      await processAnthropicStream(anthropicStream, output, stream, model, composer.toolCalls, {
        isOAuth: oauthToken,
        tools: context.tools,
      });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error(output.errorMessage || "An unknown error occurred");
      }
    },
    {
      signal: options?.signal,
      startMode: "lazy",
      tools: context.tools,
    },
  );
};

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
  model: Model<"anthropic-messages">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
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
