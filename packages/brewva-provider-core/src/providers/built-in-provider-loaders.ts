import type { ApiProvider } from "../api-registry.js";
import type { Api, SimpleStreamOptions, StreamOptions } from "../types.js";
import type { BuiltInApiProviderApi } from "./built-in-api-ids.js";
import {
  createBuiltInApiProviderRegistration,
  createNamedProviderModuleLoader,
  type LazyProviderModule,
  type NamedProviderModuleExports,
} from "./provider-loader-runtime.js";

interface BuiltInProviderRegistrationDescriptor<TApi extends BuiltInApiProviderApi> {
  api: TApi;
  loadProviderModule: () => Promise<LazyProviderModule<Api, StreamOptions, SimpleStreamOptions>>;
}

function createBuiltInProviderRegistrationDescriptor<
  TApi extends BuiltInApiProviderApi,
  TOptions extends StreamOptions,
  TStreamExport extends string,
  TSimpleExport extends string,
>(descriptor: {
  api: TApi;
  loadModule: () => Promise<
    NamedProviderModuleExports<TApi, TOptions, TStreamExport, TSimpleExport>
  >;
  streamExport: TStreamExport;
  streamSimpleExport: TSimpleExport;
}): BuiltInProviderRegistrationDescriptor<TApi> {
  return {
    api: descriptor.api,
    loadProviderModule: createNamedProviderModuleLoader(
      descriptor.api,
      descriptor.loadModule,
      descriptor.streamExport,
      descriptor.streamSimpleExport,
    ),
  };
}

function createBuiltInProviderRegistrationFromDescriptor<TApi extends BuiltInApiProviderApi>(
  descriptor: BuiltInProviderRegistrationDescriptor<TApi>,
): ApiProvider<Api, StreamOptions> {
  return createBuiltInApiProviderRegistration(descriptor.api, descriptor.loadProviderModule);
}

const STANDARD_BUILT_IN_PROVIDER_REGISTRATION_DESCRIPTORS = [
  createBuiltInProviderRegistrationDescriptor({
    api: "anthropic-messages",
    loadModule: () => import("./anthropic.js"),
    streamExport: "streamAnthropic",
    streamSimpleExport: "streamSimpleAnthropic",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "openai-completions",
    loadModule: () => import("./openai-completions.js"),
    streamExport: "streamOpenAICompletions",
    streamSimpleExport: "streamSimpleOpenAICompletions",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "mistral-conversations",
    loadModule: () => import("./mistral.js"),
    streamExport: "streamMistral",
    streamSimpleExport: "streamSimpleMistral",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "openai-responses",
    loadModule: () => import("./openai-responses.js"),
    streamExport: "streamOpenAIResponses",
    streamSimpleExport: "streamSimpleOpenAIResponses",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "azure-openai-responses",
    loadModule: () => import("./azure-openai-responses.js"),
    streamExport: "streamAzureOpenAIResponses",
    streamSimpleExport: "streamSimpleAzureOpenAIResponses",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "openai-codex-responses",
    loadModule: () => import("./openai-codex-responses.js"),
    streamExport: "streamOpenAICodexResponses",
    streamSimpleExport: "streamSimpleOpenAICodexResponses",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "google-generative-ai",
    loadModule: () => import("./google.js"),
    streamExport: "streamGoogle",
    streamSimpleExport: "streamSimpleGoogle",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "google-gemini-cli",
    loadModule: () => import("./google-gemini-cli.js"),
    streamExport: "streamGoogleGeminiCli",
    streamSimpleExport: "streamSimpleGoogleGeminiCli",
  }),
  createBuiltInProviderRegistrationDescriptor({
    api: "google-vertex",
    loadModule: () => import("./google-vertex.js"),
    streamExport: "streamGoogleVertex",
    streamSimpleExport: "streamSimpleGoogleVertex",
  }),
] as const satisfies readonly BuiltInProviderRegistrationDescriptor<BuiltInApiProviderApi>[];

const standardBuiltInApiProviderRegistrations =
  STANDARD_BUILT_IN_PROVIDER_REGISTRATION_DESCRIPTORS.map((descriptor) =>
    createBuiltInProviderRegistrationFromDescriptor(descriptor),
  );

export function getStandardBuiltInApiProviderRegistrations(): ApiProvider<Api, StreamOptions>[] {
  return [...standardBuiltInApiProviderRegistrations];
}
