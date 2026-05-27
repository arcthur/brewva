import type {
  Api,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  Model as ProviderModel,
  ProviderPayloadMetadata,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolContext, BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  VerificationGateEvidence,
  VerificationGateManifest,
} from "../../../extensions/api.js";
import type { HostedModelRoutingSettings } from "../session/settings/settings-store.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { hasHostedPromptAttemptDispatch } from "./hosted-prompt-attempt.js";
import { hasHostedRuntimeTurnPrelude } from "./runtime-turn-prelude.js";

export interface RuntimeAdapterSession extends CollectSessionPromptOutputSession {
  readonly model?: BrewvaRegisteredModel;
  getRegisteredTools(): readonly BrewvaToolDefinition[];
  getRuntimeModelCatalog(): {
    getAll?(): readonly BrewvaRegisteredModel[];
    find?(provider: string, id: string): BrewvaRegisteredModel | undefined;
    getApiKeyAndHeaders(
      model: BrewvaRegisteredModel,
    ): Promise<
      { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
    >;
    rotateCredential?(
      provider: string,
      reason: "quota" | "rate_limit" | "auth" | "manual",
      cooldownMs: number,
    ):
      | {
          providerId: string;
          credentialSlot: string;
          reason: "quota" | "rate_limit" | "auth" | "manual";
          cooldownMs: number;
        }
      | undefined;
  };
  getModelPresetState?(): BrewvaModelPresetState;
  getRuntimeActiveModelRole?(): BrewvaModelRoleAlias | undefined;
  getRuntimeModelRoutingSettings?(): HostedModelRoutingSettings | undefined;
  recordRuntimeProviderCredentialRotated?(input: {
    providerId: string;
    credentialSlot: string;
    reason: "quota" | "rate_limit" | "auth" | "manual";
    cooldownMs: number;
  }): void;
  createRuntimeToolContext(): BrewvaToolContext;
  getRuntimeVerificationGateManifests?(): readonly VerificationGateManifest[];
  getRuntimeVerificationGateEvidence?(sessionId: string): readonly VerificationGateEvidence[];
  getRuntimeVerificationGateNow?(): number;
  getRuntimeProviderCachePolicy?(): ProviderCachePolicy;
  getRuntimeProviderTransport?(): ProviderStreamOptions["transport"];
  prepareRuntimeProviderPayload?(input: {
    readonly payload: unknown;
    readonly model: ProviderModel<Api>;
    readonly metadata?: ProviderPayloadMetadata;
  }): Promise<unknown>;
  observeRuntimeCacheRender?(input: {
    readonly render: ProviderCacheRenderResult;
    readonly model: ProviderModel<Api>;
  }): void;
  observeRuntimeAssistantMessage?(message: BrewvaAgentProtocolAssistantMessage): void;
}

const DEFAULT_RUNTIME_PROVIDER_CACHE_POLICY: ProviderCachePolicy = {
  retention: "short",
  writeMode: "readWrite",
  scope: "session",
  reason: "default",
};

export function resolveRuntimeProviderCachePolicy(
  session: RuntimeAdapterSession,
): ProviderCachePolicy {
  return session.getRuntimeProviderCachePolicy?.() ?? DEFAULT_RUNTIME_PROVIDER_CACHE_POLICY;
}

export function resolveRuntimeProviderTransport(
  session: RuntimeAdapterSession,
): ProviderStreamOptions["transport"] {
  return session.getRuntimeProviderTransport?.();
}

export function isRuntimeAdapterSession(
  session: CollectSessionPromptOutputSession,
): session is RuntimeAdapterSession {
  const candidate = session as Partial<RuntimeAdapterSession>;
  return (
    typeof candidate.getRegisteredTools === "function" &&
    typeof candidate.getRuntimeModelCatalog === "function" &&
    typeof candidate.createRuntimeToolContext === "function"
  );
}

export function canCreateHostedRuntimeExecutionPorts(
  session: CollectSessionPromptOutputSession,
): boolean {
  return (
    isRuntimeAdapterSession(session) &&
    (!hasHostedPromptAttemptDispatch(session) || hasHostedRuntimeTurnPrelude(session))
  );
}
