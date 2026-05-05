import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "../contracts/index.js";
import { getExternalApiProvider, getTypedApiProvider } from "../registry/api-registry.js";
import { registerBuiltInApiProviders } from "../registry/builtins.js";
import {
  isProviderApiWithTypedOptions,
  type ProviderApiWithTypedOptions,
  type ProviderOptionsByApi,
} from "../registry/typed-options.js";

function isTypedModel(model: Model<Api>): model is Model<ProviderApiWithTypedOptions> {
  return isProviderApiWithTypedOptions(model.api);
}

function resolveExternalProvider(api: Api) {
  let provider = getExternalApiProvider(api);
  if (!provider) {
    registerBuiltInApiProviders();
    provider = getExternalApiProvider(api);
  }
  if (!provider) {
    throw new Error(`No external API provider registered for api: ${api}`);
  }
  return provider;
}

function resolveTypedProvider<TApi extends ProviderApiWithTypedOptions>(api: TApi) {
  let provider = getTypedApiProvider(api);
  if (!provider) {
    registerBuiltInApiProviders();
    provider = getTypedApiProvider(api);
  }
  if (!provider) {
    throw new Error(`No typed API provider registered for api: ${api}`);
  }
  return provider;
}

function streamTyped<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderOptionsByApi[TApi],
): AssistantMessageEventStream {
  return resolveTypedProvider(model.api).stream(model, context, options);
}

function streamExternal<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  return resolveExternalProvider(model.api).stream(model, context, options);
}

function streamSimpleTyped<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return resolveTypedProvider(model.api).streamSimple(model, context, options);
}

export function stream<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderOptionsByApi[TApi],
): AssistantMessageEventStream;
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream;
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): AssistantMessageEventStream {
  if (isTypedModel(model)) {
    return streamTyped(model, context, options);
  }
  return streamExternal(model, context, options);
}

export async function complete<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderOptionsByApi[TApi],
): Promise<AssistantMessage>;
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage>;
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): Promise<AssistantMessage> {
  const s = isTypedModel(model)
    ? streamTyped(model, context, options)
    : streamExternal(model, context, options);
  return s.result();
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (isTypedModel(model)) {
    return streamSimpleTyped(model, context, options);
  }
  return resolveExternalProvider(model.api).streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const s = streamSimple(model, context, options);
  return s.result();
}
