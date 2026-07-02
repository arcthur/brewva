import type {
  Api,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  Model as ProviderModel,
  ProviderPayloadMetadata,
  SimpleStreamOptions as ProviderStreamOptions,
} from "@brewva/brewva-provider-core/contracts";
import type { Durable } from "@brewva/brewva-std/honesty";
import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaModelCatalog, BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
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
import type {
  RuntimeProviderContextSummary,
  RuntimeProviderToolIdentity,
} from "./runtime-provider-context.js";
import { hasHostedRuntimeTurnPrelude } from "./runtime-turn-prelude.js";

export interface ProviderCredentialRotation {
  readonly providerId: string;
  readonly credentialSlot: string;
  readonly reason: "quota" | "rate_limit" | "auth" | "manual";
  readonly cooldownMs: number;
}

export interface RuntimeProviderModelCatalog extends Pick<
  BrewvaModelCatalog,
  "getAll" | "getApiKeyAndHeaders"
> {
  rotateCredential?(
    provider: string,
    reason: "quota" | "rate_limit" | "auth" | "manual",
    cooldownMs: number,
  ): ProviderCredentialRotation | undefined;
}

export interface RuntimeProviderProposalReceipt {
  readonly manifestId: string;
  readonly perToolIdentity: readonly RuntimeProviderToolIdentity[];
}

export interface PreparedRuntimeProviderPayload {
  readonly payload: unknown;
  readonly proposalReceipt?: RuntimeProviderProposalReceipt;
}

export interface RuntimeProviderFace {
  readonly model?: BrewvaRegisteredModel;
  getModelCatalog(): RuntimeProviderModelCatalog;
  getModelPresetState(): BrewvaModelPresetState;
  getActiveModelRole(): BrewvaModelRoleAlias;
  getModelRoutingSettings(): HostedModelRoutingSettings | undefined;
  recordProviderCredentialRotated(input: Durable<ProviderCredentialRotation>): void;
  recordProviderFallbackSelection(input: {
    readonly providerFallback: Record<string, JsonValue>;
    readonly turnId?: string;
  }): void;
  /**
   * Session-scoped memory of provider-classified PERMANENT model rejections
   * (`retryable: false` — entitlement, revoked credential). The recovery loop
   * marks a route once its failure is final for the turn and consults the set
   * when picking fallback candidates, so one session stops re-dialing models
   * the account cannot use. Optional: hosts without the memory keep the
   * dial-every-time behavior.
   */
  markProviderModelUnavailable?(input: {
    readonly provider: string;
    readonly modelId: string;
    readonly reason: string;
  }): void;
  /** Keyed by `provider/modelId`; value is the recorded rejection reason. */
  getUnavailableProviderModels?(): ReadonlyMap<string, string>;
  getVerificationGateManifests(): readonly VerificationGateManifest[];
  getVerificationGateEvidence(sessionId: string): readonly VerificationGateEvidence[];
  getVerificationGateNow?(): number;
  getProviderCachePolicy(): ProviderCachePolicy;
  getProviderTransport(): ProviderStreamOptions["transport"];
  prepareProviderPayload(input: {
    readonly payload: unknown;
    readonly model: ProviderModel<Api>;
    readonly metadata?: ProviderPayloadMetadata;
    readonly transmittedSecrets?: readonly string[];
    readonly turn: {
      readonly sessionId: string;
      readonly turnId?: string;
    };
    readonly providerContext: RuntimeProviderContextSummary;
  }): Promise<PreparedRuntimeProviderPayload>;
  observeCacheRender(input: {
    readonly render: ProviderCacheRenderResult;
    readonly model: ProviderModel<Api>;
  }): void;
  observeAssistantMessage(message: BrewvaAgentProtocolAssistantMessage): void;
}

export interface RuntimeToolSession extends CollectSessionPromptOutputSession {
  getRegisteredTools(): readonly BrewvaToolDefinition[];
  createRuntimeToolContext(): BrewvaToolContext;
}

export interface RuntimeAdapterSession extends RuntimeToolSession {
  getRuntimeProviderFace(): RuntimeProviderFace;
}

function isRuntimeProviderFace(value: unknown): value is RuntimeProviderFace {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RuntimeProviderFace>;
  return (
    typeof candidate.getModelCatalog === "function" &&
    typeof candidate.getModelPresetState === "function" &&
    typeof candidate.getActiveModelRole === "function" &&
    typeof candidate.getModelRoutingSettings === "function" &&
    typeof candidate.recordProviderCredentialRotated === "function" &&
    typeof candidate.recordProviderFallbackSelection === "function" &&
    typeof candidate.getVerificationGateManifests === "function" &&
    typeof candidate.getVerificationGateEvidence === "function" &&
    typeof candidate.getProviderCachePolicy === "function" &&
    typeof candidate.getProviderTransport === "function" &&
    typeof candidate.prepareProviderPayload === "function" &&
    typeof candidate.observeCacheRender === "function" &&
    typeof candidate.observeAssistantMessage === "function"
  );
}

export function resolveRuntimeProviderFace(session: RuntimeAdapterSession): RuntimeProviderFace {
  const face = session.getRuntimeProviderFace();
  if (!isRuntimeProviderFace(face)) {
    throw new Error("hosted_runtime_provider_face_incompatible");
  }
  return face;
}

export function isRuntimeAdapterSession(
  session: CollectSessionPromptOutputSession,
): session is RuntimeAdapterSession {
  if (!isRuntimeToolSession(session)) {
    return false;
  }
  const candidate = session as Partial<RuntimeAdapterSession>;
  return typeof candidate.getRuntimeProviderFace === "function";
}

export function isRuntimeToolSession(
  session: CollectSessionPromptOutputSession,
): session is RuntimeToolSession {
  const candidate = session as Partial<RuntimeToolSession>;
  return (
    typeof candidate.getRegisteredTools === "function" &&
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
