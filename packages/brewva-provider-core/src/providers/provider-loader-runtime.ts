import type { ApiProvider } from "../api-registry.js";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import type { BuiltInApiProviderApi } from "./built-in-api-ids.js";

export interface LazyProviderModule<
  TApi extends Api,
  TOptions extends StreamOptions,
  TSimpleOptions extends SimpleStreamOptions,
> {
  stream: (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
  ) => AsyncIterable<AssistantMessageEvent>;
  streamSimple: (
    model: Model<TApi>,
    context: Context,
    options?: TSimpleOptions,
  ) => AsyncIterable<AssistantMessageEvent>;
}

export type NamedProviderModuleExports<
  TApi extends Api,
  TOptions extends StreamOptions,
  TStreamExport extends string,
  TSimpleExport extends string,
> = Record<TStreamExport, StreamFunction<TApi, TOptions>> &
  Record<TSimpleExport, StreamFunction<TApi, SimpleStreamOptions>>;

function forwardStream(
  target: AssistantMessageEventStream,
  source: AsyncIterable<AssistantMessageEvent>,
): void {
  (async () => {
    for await (const event of source) {
      target.push(event);
    }
    target.end();
  })();
}

function createLazyLoadErrorMessage<TApi extends Api>(
  model: Model<TApi>,
  error: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function createLazyStream<
  TApi extends Api,
  TOptions extends StreamOptions,
  TSimpleOptions extends SimpleStreamOptions,
>(
  loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();

    loadModule()
      .then((module) => {
        const inner = module.stream(model, context, options);
        forwardStream(outer, inner);
      })
      .catch((error) => {
        const message = createLazyLoadErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });

    return outer;
  };
}

export function createLazySimpleStream<
  TApi extends Api,
  TOptions extends StreamOptions,
  TSimpleOptions extends SimpleStreamOptions,
>(
  loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TSimpleOptions> {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();

    loadModule()
      .then((module) => {
        const inner = module.streamSimple(model, context, options);
        forwardStream(outer, inner);
      })
      .catch((error) => {
        const message = createLazyLoadErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });

    return outer;
  };
}

export function createCachedModuleLoader<TModule>(
  load: () => Promise<TModule>,
): () => Promise<TModule> {
  let cached: Promise<TModule> | undefined;
  return () => {
    cached ||= load();
    return cached;
  };
}

export function createNamedProviderModuleLoader<
  TApi extends Api,
  TOptions extends StreamOptions,
  TStreamExport extends string,
  TSimpleExport extends string,
>(
  api: TApi,
  loadModule: () => Promise<
    NamedProviderModuleExports<TApi, TOptions, TStreamExport, TSimpleExport>
  >,
  streamExport: TStreamExport,
  streamSimpleExport: TSimpleExport,
): () => Promise<LazyProviderModule<Api, StreamOptions, SimpleStreamOptions>> {
  return createCachedModuleLoader(async () => {
    const module = await loadModule();
    const stream = module[streamExport];
    const streamSimple = module[streamSimpleExport];
    return {
      stream: (model, context, options) => {
        if (model.api !== api) {
          throw new Error(`Mismatched api: ${model.api} expected ${api}`);
        }
        return stream(model as Model<TApi>, context, options as TOptions);
      },
      streamSimple: (model, context, options) => {
        if (model.api !== api) {
          throw new Error(`Mismatched api: ${model.api} expected ${api}`);
        }
        return streamSimple(model as Model<TApi>, context, options);
      },
    };
  });
}

export function createBuiltInApiProviderRegistration<
  TApi extends BuiltInApiProviderApi,
  TOptions extends StreamOptions,
>(
  api: TApi,
  loadModule: () => Promise<LazyProviderModule<TApi, TOptions, SimpleStreamOptions>>,
): ApiProvider<Api, StreamOptions> {
  const stream = createLazyStream(loadModule);
  const streamSimple = createLazySimpleStream(loadModule);
  return {
    api,
    stream: (model, context, options) => {
      if (model.api !== api) {
        throw new Error(`Mismatched api: ${model.api} expected ${api}`);
      }
      return stream(model as Model<TApi>, context, options as TOptions);
    },
    streamSimple: (model, context, options) => {
      if (model.api !== api) {
        throw new Error(`Mismatched api: ${model.api} expected ${api}`);
      }
      return streamSimple(model as Model<TApi>, context, options);
    },
  };
}
