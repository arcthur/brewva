import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderSessionResources,
} from "../contracts/index.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  clearApiProviders,
  registerTypedApiProvider,
  type TypedApiProvider,
  type TypedApiProviderUnion,
} from "./api-registry.js";
import {
  TYPED_PROVIDER_APIS,
  type ProviderApiWithTypedOptions,
  type ProviderOptionsByApi,
  type ProviderSimpleOptionsByApi,
} from "./typed-options.js";

export const BUILT_IN_API_PROVIDER_APIS = TYPED_PROVIDER_APIS;

export type BuiltInApiProviderApi = (typeof BUILT_IN_API_PROVIDER_APIS)[number];

export interface LazyProviderModule<TApi extends ProviderApiWithTypedOptions> {
  stream: (
    model: Model<TApi>,
    context: Context,
    options?: ProviderOptionsByApi[TApi],
  ) => AsyncIterable<AssistantMessageEvent>;
  streamSimple: (
    model: Model<TApi>,
    context: Context,
    options?: ProviderSimpleOptionsByApi[TApi],
  ) => AsyncIterable<AssistantMessageEvent>;
  sessionResources?: ProviderSessionResources;
}

export interface CachedModuleLoader<TModule> {
  (): Promise<TModule>;
  peek(): TModule | undefined;
}

interface BuiltInProviderRegistrationFactory<TApi extends BuiltInApiProviderApi> {
  api: TApi;
  create(): TypedApiProvider<TApi>;
}

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

function createLazyStream<TApi extends ProviderApiWithTypedOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi>>,
): TypedApiProvider<TApi>["stream"] {
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

function createLazySimpleStream<TApi extends ProviderApiWithTypedOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi>>,
): TypedApiProvider<TApi>["streamSimple"] {
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
): CachedModuleLoader<TModule> {
  let cached: Promise<TModule> | undefined;
  let resolved: TModule | undefined;
  const loader = (() => {
    cached ||= load();
    void cached.then((module) => {
      resolved = module;
    });
    return cached;
  }) as CachedModuleLoader<TModule>;
  loader.peek = () => resolved;
  return loader;
}

export function createProviderModuleLoader<TApi extends ProviderApiWithTypedOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi>>,
): CachedModuleLoader<LazyProviderModule<TApi>> {
  return createCachedModuleLoader(loadModule);
}

export function createBuiltInApiProviderRegistration<TApi extends BuiltInApiProviderApi>(
  api: TApi,
  loadModule: CachedModuleLoader<LazyProviderModule<TApi>>,
): TypedApiProvider<TApi> {
  return {
    api,
    stream: createLazyStream(loadModule),
    streamSimple: createLazySimpleStream(loadModule),
    sessionResources: {
      clearSession(sessionId) {
        const loadedModule = loadModule.peek();
        if (loadedModule) {
          return loadedModule.sessionResources?.clearSession(sessionId);
        }
        return loadModule().then((module) => module.sessionResources?.clearSession(sessionId));
      },
    },
  };
}

function createBuiltInProviderRegistrationFactory<TApi extends BuiltInApiProviderApi>(descriptor: {
  api: TApi;
  loadModule: () => Promise<LazyProviderModule<TApi>>;
}): BuiltInProviderRegistrationFactory<TApi> {
  const loadProviderModule = createProviderModuleLoader(descriptor.loadModule);
  return {
    api: descriptor.api,
    create() {
      return createBuiltInApiProviderRegistration(descriptor.api, loadProviderModule);
    },
  };
}

const STANDARD_BUILT_IN_PROVIDER_REGISTRATION_FACTORIES = [
  createBuiltInProviderRegistrationFactory({
    api: "anthropic-messages",
    loadModule: async () => {
      const module = await import("../providers/anthropic/index.js");
      return {
        stream: module.streamAnthropic,
        streamSimple: module.streamSimpleAnthropic,
      };
    },
  }),
  createBuiltInProviderRegistrationFactory({
    api: "openai-completions",
    loadModule: async () => {
      const module = await import("../providers/openai-completions/index.js");
      return {
        stream: module.streamOpenAICompletions,
        streamSimple: module.streamSimpleOpenAICompletions,
      };
    },
  }),
  createBuiltInProviderRegistrationFactory({
    api: "openai-responses",
    loadModule: async () => {
      const module = await import("../providers/openai-responses/index.js");
      return {
        stream: module.streamOpenAIResponses,
        streamSimple: module.streamSimpleOpenAIResponses,
      };
    },
  }),
  createBuiltInProviderRegistrationFactory({
    api: "openai-codex-responses",
    loadModule: async () => {
      const module = await import("../providers/openai-codex-responses/index.js");
      return {
        stream: module.streamOpenAICodexResponses,
        streamSimple: module.streamSimpleOpenAICodexResponses,
        sessionResources: module.sessionResources,
      };
    },
  }),
  createBuiltInProviderRegistrationFactory({
    api: "google-gemini-cli",
    loadModule: async () => {
      const module = await import("../providers/google-gemini-cli/index.js");
      return {
        stream: module.streamGoogleGeminiCli,
        streamSimple: module.streamSimpleGoogleGeminiCli,
      };
    },
  }),
] as const;

export function getStandardBuiltInApiProviderRegistrations() {
  const registrations: TypedApiProviderUnion[] = [];
  for (const factory of STANDARD_BUILT_IN_PROVIDER_REGISTRATION_FACTORIES) {
    registrations.push(factory.create());
  }
  return registrations;
}

export function registerBuiltInApiProviders(): void {
  for (const registration of getStandardBuiltInApiProviderRegistrations()) {
    registerTypedApiProvider(registration);
  }
}

export function resetApiProviders(): void {
  clearApiProviders();
  registerBuiltInApiProviders();
}
