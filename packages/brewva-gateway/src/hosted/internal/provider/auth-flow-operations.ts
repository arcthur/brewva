import type { CredentialVaultService } from "@brewva/brewva-runtime/security";
import type { HostedAuthCredential } from "../session/settings/hosted-auth-store.js";
import type { ProviderAuthFlowOperations } from "./auth-flow.js";
import {
  API_KEY_UNSUPPORTED_PROVIDERS,
  KIMI_CODE_PROVIDER,
  KIMI_PROVIDER,
  MOONSHOT_AI_PROVIDER,
  MOONSHOT_CN_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_PROVIDER,
  TOKEN_PROVIDERS,
  getProviderCredentialRef,
  type ProviderConnectionAuthStore,
} from "./shared.js";
import type {
  ProviderApiKeyAuthMethod,
  ProviderAuthHandler,
  ProviderOAuthAuthMethod,
  ProviderOAuthAuthorization,
  ProviderOAuthCompletion,
} from "./types.js";

export function createProviderAuthFlowOperations(input: {
  vault: CredentialVaultService;
  authStore?: ProviderConnectionAuthStore;
  authHandlers: readonly ProviderAuthHandler[];
  pendingOAuthCompletions: Map<
    string,
    Pick<ProviderOAuthCompletion, "complete"> & {
      credentialProvider: string;
      completionPromise?: Promise<HostedAuthCredential>;
      stored?: boolean;
    }
  >;
  refresh(): Promise<void>;
}): ProviderAuthFlowOperations {
  const kimiApiKeyMethods = (): ProviderApiKeyAuthMethod[] => [
    {
      id: "kimi_code_api_key",
      kind: "api_key",
      type: "api",
      label: "Kimi Code",
      credentialRef: getProviderCredentialRef(KIMI_CODE_PROVIDER),
      credentialProvider: KIMI_CODE_PROVIDER,
      modelProviderFilter: KIMI_CODE_PROVIDER,
    },
    {
      id: "moonshot_cn_api_key",
      kind: "api_key",
      type: "api",
      label: "Moonshot AI Open Platform (moonshot.cn)",
      credentialRef: getProviderCredentialRef(MOONSHOT_CN_PROVIDER),
      credentialProvider: MOONSHOT_CN_PROVIDER,
      modelProviderFilter: MOONSHOT_CN_PROVIDER,
    },
    {
      id: "moonshot_ai_api_key",
      kind: "api_key",
      type: "api",
      label: "Moonshot AI Open Platform (moonshot.ai)",
      credentialRef: getProviderCredentialRef(MOONSHOT_AI_PROVIDER),
      credentialProvider: MOONSHOT_AI_PROVIDER,
      modelProviderFilter: MOONSHOT_AI_PROVIDER,
    },
  ];

  const apiKeyMethodForProvider = (provider: string): ProviderApiKeyAuthMethod | undefined => {
    if (API_KEY_UNSUPPORTED_PROVIDERS.has(provider)) {
      return undefined;
    }
    const label =
      provider === OPENAI_PROVIDER || provider === OPENAI_CODEX_PROVIDER
        ? "Manually enter API Key"
        : TOKEN_PROVIDERS.has(provider)
          ? "Token"
          : "API key";
    const credentialProvider = provider === OPENAI_CODEX_PROVIDER ? OPENAI_PROVIDER : provider;
    return {
      id: "api_key",
      kind: "api_key",
      type: "api",
      label,
      credentialRef: getProviderCredentialRef(credentialProvider),
      credentialProvider,
      modelProviderFilter: credentialProvider,
    };
  };

  const oauthMethodsForProvider = (provider: string): ProviderOAuthAuthMethod[] => {
    if (!input.authStore?.set) {
      return [];
    }
    const authProvider = provider === OPENAI_PROVIDER ? OPENAI_CODEX_PROVIDER : provider;
    const byId = new Map<string, ProviderOAuthAuthMethod>();
    for (const handler of input.authHandlers) {
      if (handler.provider !== authProvider) {
        continue;
      }
      for (const method of handler.listAuthMethods()) {
        byId.set(method.id, {
          ...method,
          credentialProvider: authProvider,
          modelProviderFilter: authProvider,
        });
      }
    }
    return [...byId.values()];
  };

  const authorizeWithHandler = async (
    provider: string,
    methodId: string,
    inputs: Record<string, string>,
  ): Promise<ProviderOAuthCompletion | undefined> => {
    for (const handler of input.authHandlers.toReversed()) {
      if (handler.provider !== provider) {
        continue;
      }
      if (!handler.listAuthMethods().some((method) => method.id === methodId)) {
        continue;
      }
      const authorization = await handler.authorizeOAuth(methodId, inputs);
      if (authorization) {
        return authorization;
      }
    }
    return undefined;
  };

  return {
    listAuthMethods(provider) {
      if (provider === KIMI_PROVIDER) {
        return kimiApiKeyMethods();
      }
      const apiKeyMethod = apiKeyMethodForProvider(provider);
      return [...oauthMethodsForProvider(provider), ...(apiKeyMethod ? [apiKeyMethod] : [])];
    },
    async authorizeOAuth(provider, methodId, inputs = {}) {
      if (!input.authStore?.set) {
        throw new Error("OAuth credential storage is unavailable for this session.");
      }
      const method = this.listAuthMethods(provider).find((candidate) => candidate.id === methodId);
      const credentialProvider = method?.credentialProvider ?? provider;
      const authorization = await authorizeWithHandler(credentialProvider, methodId, inputs);
      if (!authorization) {
        return undefined;
      }
      const publicAuthorization: ProviderOAuthAuthorization = {
        url: authorization.url,
        method: authorization.method,
        instructions: authorization.instructions,
        copyText: authorization.copyText,
        openBrowser: authorization.openBrowser,
        manualCode: authorization.manualCode,
      };
      input.pendingOAuthCompletions.set(`${provider}:${methodId}`, {
        complete: (code?: string) => authorization.complete(code),
        credentialProvider,
      });
      return publicAuthorization;
    },
    async completeOAuth(provider, methodId, code) {
      if (!input.authStore?.set) {
        throw new Error("OAuth credential storage is unavailable for this session.");
      }
      const key = `${provider}:${methodId}`;
      const pending = input.pendingOAuthCompletions.get(key);
      if (!pending) {
        throw new Error(`No pending OAuth authorization for ${provider}.`);
      }
      try {
        const credential = code
          ? await pending.complete(code)
          : await (pending.completionPromise ??= pending.complete());
        if (!pending.stored) {
          pending.stored = true;
          input.authStore.set(pending.credentialProvider, credential);
          input.vault.remove(getProviderCredentialRef(pending.credentialProvider));
          await input.refresh();
        }
      } finally {
        input.pendingOAuthCompletions.delete(key);
      }
    },
  };
}
