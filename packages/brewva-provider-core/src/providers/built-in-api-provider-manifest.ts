import type { ApiProvider } from "../api-registry.js";
import type { Api, StreamOptions } from "../types.js";
import { loadBedrockProviderModule } from "./bedrock-provider-loader.js";
import { getStandardBuiltInApiProviderRegistrations } from "./built-in-provider-loaders.js";
import { createBuiltInApiProviderRegistration } from "./provider-loader-runtime.js";

export function getBuiltInApiProviderRegistrations(): ApiProvider<Api, StreamOptions>[] {
  return [
    ...getStandardBuiltInApiProviderRegistrations(),
    createBuiltInApiProviderRegistration("bedrock-converse-stream", loadBedrockProviderModule),
  ];
}
