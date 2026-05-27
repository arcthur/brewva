import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderAssistantMessageStream,
  ProviderSessionResources,
} from "../contracts/index.js";
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
  ) => ProviderAssistantMessageStream;
  streamSimple: (
    model: Model<TApi>,
    context: Context,
    options?: ProviderSimpleOptionsByApi[TApi],
  ) => ProviderAssistantMessageStream;
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

function createLazyLoadErrorStream<TApi extends Api>(
  model: Model<TApi>,
  error: unknown,
): ProviderAssistantMessageStream {
  const message = createLazyLoadErrorMessage(model, error);
  const event: AssistantMessageEvent = {
    type: "error",
    reason: "error",
    error: message,
  };
  return BrewvaStream.make(event);
}

function createLazyStream<TApi extends ProviderApiWithTypedOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi>>,
): TypedApiProvider<TApi>["stream"] {
  return (model, context, options) => {
    return BrewvaStream.unwrap(
      BrewvaEffect.tryPromise({
        try: () => loadModule(),
        catch: (error) => error,
      }).pipe(
        BrewvaEffect.map((module) => module.stream(model, context, options)),
        BrewvaEffect.catch((error) =>
          BrewvaEffect.succeed(createLazyLoadErrorStream(model, error)),
        ),
      ),
    );
  };
}

function createLazySimpleStream<TApi extends ProviderApiWithTypedOptions>(
  loadModule: () => Promise<LazyProviderModule<TApi>>,
): TypedApiProvider<TApi>["streamSimple"] {
  return (model, context, options) => {
    return BrewvaStream.unwrap(
      BrewvaEffect.tryPromise({
        try: () => loadModule(),
        catch: (error) => error,
      }).pipe(
        BrewvaEffect.map((module) => module.streamSimple(model, context, options)),
        BrewvaEffect.catch((error) =>
          BrewvaEffect.succeed(createLazyLoadErrorStream(model, error)),
        ),
      ),
    );
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
    api: "google-genai",
    loadModule: async () => {
      const module = await import("../providers/google-genai/index.js");
      return {
        stream: module.streamGoogleGenAI,
        streamSimple: module.streamSimpleGoogleGenAI,
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
