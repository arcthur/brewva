import type { CredentialVaultService } from "@brewva/brewva-runtime/credentials";
import type { ProviderCredentialOperations } from "./credential.js";
import {
  KIMI_COVERED_PROVIDERS,
  KIMI_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_PROVIDER,
  getProviderCredentialRef,
  type ProviderConnectionAuthStore,
} from "./shared.js";
import type { ProviderConnectionDescriptor } from "./types.js";

export function createProviderCredentialOperations(input: {
  vault: CredentialVaultService;
  authStore?: ProviderConnectionAuthStore;
  listProviders(): Promise<ProviderConnectionDescriptor[]>;
  refresh(): Promise<void>;
}): ProviderCredentialOperations {
  return {
    listProviders: () => input.listProviders(),
    async connectApiKey(provider, key) {
      input.authStore?.remove?.(provider);
      input.vault.put(getProviderCredentialRef(provider), key);
      await input.refresh();
    },
    async disconnect(provider) {
      const providers =
        provider === OPENAI_PROVIDER
          ? [OPENAI_PROVIDER, OPENAI_CODEX_PROVIDER]
          : provider === KIMI_PROVIDER
            ? [...KIMI_COVERED_PROVIDERS]
            : [provider];
      for (const targetProvider of providers) {
        input.vault.remove(getProviderCredentialRef(targetProvider));
        input.authStore?.remove?.(targetProvider);
      }
      await input.refresh();
    },
    refresh: () => input.refresh(),
  };
}
