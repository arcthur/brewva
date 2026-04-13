import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import { getBuiltInApiProviderRegistrations } from "./built-in-api-provider-manifest.js";
export { setBedrockProviderModule } from "./bedrock-provider-loader.js";

export function registerBuiltInApiProviders(): void {
  for (const registration of getBuiltInApiProviderRegistrations()) {
    registerApiProvider(registration);
  }
}

export function resetApiProviders(): void {
  clearApiProviders();
  registerBuiltInApiProviders();
}
