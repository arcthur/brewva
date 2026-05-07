import type {
  Api,
  Context,
  ProviderAssistantMessageStream,
  ProviderSessionResources,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../contracts/index.js";
import {
  isProviderApiWithTypedOptions,
  type ProviderApiWithTypedOptions,
  type ProviderOptionsByApi,
} from "./typed-options.js";

export type ApiStreamFunction = (
  model: import("../contracts/index.js").Model<Api>,
  context: Context,
  options?: StreamOptions,
) => ProviderAssistantMessageStream;

export type ApiStreamSimpleFunction = (
  model: import("../contracts/index.js").Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => ProviderAssistantMessageStream;

export interface ApiProvider<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
  sessionResources?: ProviderSessionResources;
}

export type TypedApiProvider<TApi extends ProviderApiWithTypedOptions> = ApiProvider<
  TApi,
  ProviderOptionsByApi[TApi]
>;

type TypedApiProviderByApi = {
  [TApi in ProviderApiWithTypedOptions]: TypedApiProvider<TApi>;
};
export type TypedApiProviderUnion = TypedApiProviderByApi[ProviderApiWithTypedOptions];
export type ExternalApiProvider<TApi extends Api = Api> = ApiProvider<TApi, StreamOptions>;
export type AnyRegisteredApiProvider = TypedApiProviderUnion | ExternalApiProvider<Api>;

type RegisteredTypedApiProvider = {
  provider: TypedApiProviderUnion;
  sourceId?: string;
};

type RegisteredExternalApiProvider = {
  provider: ExternalApiProvider<Api>;
  sourceId?: string;
};

const typedApiProviderRegistry = new Map<ProviderApiWithTypedOptions, RegisteredTypedApiProvider>();
const externalApiProviderRegistry = new Map<Api, RegisteredExternalApiProvider>();

function isTypedApiProvider(provider: AnyRegisteredApiProvider): provider is TypedApiProviderUnion {
  return isProviderApiWithTypedOptions(provider.api);
}

export function registerTypedApiProvider(provider: TypedApiProviderUnion, sourceId?: string): void {
  typedApiProviderRegistry.set(provider.api, { provider, sourceId });
  externalApiProviderRegistry.delete(provider.api);
}

export function registerExternalApiProvider(
  provider: ExternalApiProvider<Api>,
  sourceId?: string,
): void {
  externalApiProviderRegistry.set(provider.api, {
    provider,
    sourceId,
  });
}

export function registerApiProvider<TApi extends Api>(
  provider: TApi extends ProviderApiWithTypedOptions
    ? TypedApiProvider<TApi>
    : ExternalApiProvider<TApi>,
  sourceId?: string,
): void;
export function registerApiProvider(provider: AnyRegisteredApiProvider, sourceId?: string): void {
  if (isTypedApiProvider(provider)) {
    registerTypedApiProvider(provider, sourceId);
    return;
  }
  registerExternalApiProvider(provider, sourceId);
}

export function getTypedApiProvider<TApi extends ProviderApiWithTypedOptions>(
  api: TApi,
): TypedApiProvider<TApi> | undefined {
  return typedApiProviderRegistry.get(api)?.provider as TypedApiProvider<TApi> | undefined;
}

function getTypedApiProviderUnion(
  api: ProviderApiWithTypedOptions,
): TypedApiProviderUnion | undefined {
  return typedApiProviderRegistry.get(api)?.provider;
}

export function getExternalApiProvider(api: Api): ExternalApiProvider<Api> | undefined {
  return externalApiProviderRegistry.get(api)?.provider;
}

export function getApiProvider(api: Api): AnyRegisteredApiProvider | undefined {
  if (isProviderApiWithTypedOptions(api)) {
    return getTypedApiProviderUnion(api);
  }
  return getExternalApiProvider(api);
}

export function getApiProviders(): AnyRegisteredApiProvider[] {
  const typedProviders = Array.from(typedApiProviderRegistry.values(), (entry) => entry.provider);
  const externalProviders = Array.from(
    externalApiProviderRegistry.values(),
    (entry) => entry.provider,
  );
  return [...typedProviders, ...externalProviders];
}

export function unregisterApiProviders(sourceId: string): void {
  for (const [api, entry] of typedApiProviderRegistry.entries()) {
    if (entry.sourceId === sourceId) {
      typedApiProviderRegistry.delete(api);
    }
  }
  for (const [api, entry] of externalApiProviderRegistry.entries()) {
    if (entry.sourceId === sourceId) {
      externalApiProviderRegistry.delete(api);
    }
  }
}

export function clearApiProviders(): void {
  typedApiProviderRegistry.clear();
  externalApiProviderRegistry.clear();
}

export async function clearApiProviderSessions(sessionId: string): Promise<void> {
  const pendingClears: Array<void | Promise<void>> = [];
  for (const entry of typedApiProviderRegistry.values()) {
    pendingClears.push(entry.provider.sessionResources?.clearSession(sessionId));
  }
  for (const entry of externalApiProviderRegistry.values()) {
    pendingClears.push(entry.provider.sessionResources?.clearSession(sessionId));
  }
  await Promise.all(pendingClears);
}
