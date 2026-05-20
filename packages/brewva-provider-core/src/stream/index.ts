import { runBoundaryOperation } from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderAssistantMessageStream,
  SimpleStreamOptions,
  StreamOptions,
} from "../contracts/index.js";
import { ProviderStreamError, providerRuntimeLayer } from "../contracts/index.js";
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
): ProviderAssistantMessageStream {
  return resolveTypedProvider(model.api).stream(model, context, options);
}

function streamExternal<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): ProviderAssistantMessageStream {
  return resolveExternalProvider(model.api).stream(model, context, options);
}

function streamSimpleTyped<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): ProviderAssistantMessageStream {
  return resolveTypedProvider(model.api).streamSimple(model, context, options);
}

export function stream<TApi extends ProviderApiWithTypedOptions>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderOptionsByApi[TApi],
): ProviderAssistantMessageStream;
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): ProviderAssistantMessageStream;
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: StreamOptions,
): ProviderAssistantMessageStream {
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
  return runProviderStreamToCompletion(s);
}

export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): ProviderAssistantMessageStream {
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
  return runProviderStreamToCompletion(s);
}

function runProviderStreamToCompletion(
  providerStream: ProviderAssistantMessageStream,
): Promise<AssistantMessage> {
  return runBoundaryOperation(
    "provider.stream.complete",
    providerStream.pipe(
      BrewvaStream.runFoldEffect(
        (): AssistantMessage | undefined => undefined,
        (message, event) => {
          if (event.type === "done") {
            return BrewvaEffect.succeed(event.message);
          }
          if (event.type === "error") {
            return BrewvaEffect.fail(
              new ProviderStreamError({
                message: event.error.errorMessage ?? "Provider stream failed",
                cause: event.error,
              }),
            );
          }
          return BrewvaEffect.succeed(message);
        },
      ),
      BrewvaEffect.flatMap((message) =>
        message
          ? BrewvaEffect.succeed(message)
          : BrewvaEffect.fail(
              new ProviderStreamError({
                message: "Provider stream ended before producing a final message",
              }),
            ),
      ),
      BrewvaEffect.provide(providerRuntimeLayer),
    ),
  );
}
