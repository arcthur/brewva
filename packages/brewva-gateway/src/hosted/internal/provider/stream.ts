import type {
  Api,
  Context as ProviderStreamContext,
  Model as ProviderStreamModel,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import { streamSimple } from "@brewva/brewva-provider-core/stream";
import type {
  BrewvaTurnLoopStreamContext,
  BrewvaTurnLoopStreamFunction,
  BrewvaTurnLoopStreamOptions,
} from "@brewva/brewva-substrate/turn";

function toProviderModel(
  model: Parameters<BrewvaTurnLoopStreamFunction>[0],
): ProviderStreamModel<Api> {
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

function toProviderContext(context: BrewvaTurnLoopStreamContext): ProviderStreamContext {
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

function toProviderOptions(
  options: BrewvaTurnLoopStreamOptions,
  model: Parameters<BrewvaTurnLoopStreamFunction>[0],
): ProviderStreamOptions {
  return {
    reasoning: options.reasoning === "off" ? undefined : options.reasoning,
    signal: options.signal,
    apiKey: options.apiKey,
    transport: options.transport,
    sessionId: options.sessionId,
    cachePolicy: options.cachePolicy,
    onCacheRender: options.onCacheRender
      ? (render) => options.onCacheRender?.(render, model)
      : undefined,
    onPayload: options.onPayload,
    headers: options.headers,
    maxRetryDelayMs: options.maxRetryDelayMs,
    thinkingBudgets: options.thinkingBudgets,
    resolveFile: options.resolveFile ? (part) => options.resolveFile?.(part, model) : undefined,
  };
}

export const createHostedProviderStreamFunction = (): BrewvaTurnLoopStreamFunction => {
  return (model, context, options) => {
    return streamSimple(
      toProviderModel(model),
      toProviderContext(context),
      toProviderOptions(options, model),
    );
  };
};
