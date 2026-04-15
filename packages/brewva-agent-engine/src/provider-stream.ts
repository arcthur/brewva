import { streamSimple } from "@brewva/brewva-provider-core";
import type {
  AssistantMessage as ProviderAssistantMessage,
  AssistantMessageEventStream as ProviderAssistantMessageEventStream,
} from "@brewva/brewva-provider-core";
import type {
  BrewvaAgentEngineStreamContext,
  BrewvaAgentEngineStreamFunction,
  BrewvaAgentEngineStreamOptions,
  BrewvaAssistantMessageEventStream,
} from "./agent-engine-types.js";

type AsyncIterableValue<TIterable extends AsyncIterable<unknown>> =
  TIterable extends AsyncIterable<infer TValue> ? TValue : never;

type ProviderStreamModel = Parameters<typeof streamSimple>[0];
type ProviderStreamContext = Parameters<typeof streamSimple>[1];
type ProviderStreamOptions = NonNullable<Parameters<typeof streamSimple>[2]>;
type ProviderAssistantMessageEvent = AsyncIterableValue<ProviderAssistantMessageEventStream>;

function toProviderModel(
  model: Parameters<BrewvaAgentEngineStreamFunction>[0],
): ProviderStreamModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers ? { ...model.headers } : undefined,
    compat:
      model.api === "openai-completions" || model.api === "openai-responses"
        ? model.compat
        : undefined,
  };
}

function toProviderContext(context: BrewvaAgentEngineStreamContext): ProviderStreamContext {
  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => ({ ...message })),
    tools: context.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}

function toProviderOptions(options: BrewvaAgentEngineStreamOptions): ProviderStreamOptions {
  return {
    reasoning: options.reasoning === "off" ? undefined : options.reasoning,
    signal: options.signal,
    apiKey: options.apiKey,
    transport: options.transport,
    sessionId: options.sessionId,
    onPayload: options.onPayload,
    headers: options.headers,
    maxRetryDelayMs: options.maxRetryDelayMs,
    thinkingBudgets: options.thinkingBudgets,
    resolveFile: options.resolveFile as ProviderStreamOptions["resolveFile"],
  };
}

function toAssistantMessage(message: ProviderAssistantMessage) {
  return {
    ...message,
  };
}

function toAssistantMessageEvent(event: ProviderAssistantMessageEvent) {
  if (event.type === "done") {
    return {
      ...event,
      message: toAssistantMessage(event.message),
    };
  }
  if (event.type === "error") {
    return {
      ...event,
      error: toAssistantMessage(event.error),
    };
  }
  return {
    ...event,
    partial: toAssistantMessage(event.partial),
  };
}

function toHostedEventStream(
  providerStream: ProviderAssistantMessageEventStream,
): BrewvaAssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of providerStream) {
        yield toAssistantMessageEvent(event);
      }
    },
    async result() {
      return toAssistantMessage(await providerStream.result());
    },
  };
}

export const createHostedProviderStreamFunction = (): BrewvaAgentEngineStreamFunction => {
  return async (model, context, options) => {
    const providerStream = streamSimple(
      toProviderModel(model),
      toProviderContext(context),
      toProviderOptions(options),
    );
    return toHostedEventStream(providerStream);
  };
};

export type {
  BrewvaAgentEngineStreamContext as HostedProviderStreamContext,
  BrewvaAgentEngineStreamOptions as HostedProviderStreamOptions,
};
