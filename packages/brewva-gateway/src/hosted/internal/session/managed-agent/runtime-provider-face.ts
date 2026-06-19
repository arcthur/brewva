import { type BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPresetState,
  BrewvaModelRoleAlias,
} from "@brewva/brewva-substrate/session";
import { type VerificationGateManifest } from "../../../../extensions/api.js";
import type { RuntimeProviderFace } from "../../turn/runtime-turn-session.js";
import { readRuntimeVerificationGateEvidenceFromEvent } from "../../turn/runtime-turn-verification-gates.js";
import { queryRuntimeEvents, type HostedRuntimeAdapterPort } from "../runtime-ports.js";
import {
  type BrewvaManagedAgentSessionSettingsPort,
  type RuntimeProviderCacheRenderInput,
  type RuntimeProviderPayloadInput,
} from "./session-contracts.js";

/** Owns the explicit provider-facing contract consumed by turn dispatch. */
export class ManagedSessionRuntimeProviderFace implements RuntimeProviderFace {
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #runtime: HostedRuntimeAdapterPort;
  readonly #getSessionId: () => string;
  readonly #verificationGateManifests: readonly VerificationGateManifest[];
  readonly #modelRole: BrewvaModelRoleAlias | undefined;
  readonly #getModel: () => BrewvaRegisteredModel | undefined;
  readonly #getModelPresetState: () => BrewvaModelPresetState;
  readonly #prepareRuntimeProviderPayload:
    | ((input: RuntimeProviderPayloadInput) => Promise<unknown>)
    | undefined;
  readonly #observeRuntimeCacheRender:
    | ((input: RuntimeProviderCacheRenderInput) => void)
    | undefined;
  readonly #onProviderAssistantMessage:
    | ((message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>) => void)
    | undefined;

  constructor(input: {
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    runtime: HostedRuntimeAdapterPort;
    getSessionId: () => string;
    verificationGateManifests: readonly VerificationGateManifest[];
    modelRole?: BrewvaModelRoleAlias;
    getModel: () => BrewvaRegisteredModel | undefined;
    getModelPresetState: () => BrewvaModelPresetState;
    prepareRuntimeProviderPayload?: (input: RuntimeProviderPayloadInput) => Promise<unknown>;
    observeRuntimeCacheRender?: (input: RuntimeProviderCacheRenderInput) => void;
    onProviderAssistantMessage?: (
      message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>,
    ) => void;
  }) {
    this.#settings = input.settings;
    this.#catalog = input.catalog;
    this.#runtime = input.runtime;
    this.#getSessionId = input.getSessionId;
    this.#verificationGateManifests = input.verificationGateManifests;
    this.#modelRole = input.modelRole;
    this.#getModel = input.getModel;
    this.#getModelPresetState = input.getModelPresetState;
    this.#prepareRuntimeProviderPayload = input.prepareRuntimeProviderPayload;
    this.#observeRuntimeCacheRender = input.observeRuntimeCacheRender;
    this.#onProviderAssistantMessage = input.onProviderAssistantMessage;
  }

  get model(): BrewvaRegisteredModel | undefined {
    return this.#getModel();
  }

  getActiveModelRole(): BrewvaModelRoleAlias {
    return this.#modelRole ?? "default";
  }

  getModelCatalog(): BrewvaMutableModelCatalog {
    return this.#catalog;
  }

  getModelPresetState(): BrewvaModelPresetState {
    return this.#getModelPresetState();
  }

  getProviderCachePolicy() {
    return this.#settings.getCachePolicy();
  }

  getProviderTransport() {
    return this.#settings.getTransport();
  }

  getVerificationGateManifests() {
    return this.#verificationGateManifests;
  }

  getVerificationGateEvidence(sessionId: string) {
    return queryRuntimeEvents(this.#runtime, sessionId, { last: 100 }).flatMap((event) => {
      const evidence = readRuntimeVerificationGateEvidenceFromEvent(event);
      return evidence ? [evidence] : [];
    });
  }

  getModelRoutingSettings() {
    return this.#settings.getModelRoutingSettings?.();
  }

  recordProviderCredentialRotated(input: {
    providerId: string;
    credentialSlot: string;
    reason: "quota" | "rate_limit" | "auth" | "manual";
    cooldownMs: number;
  }): void {
    this.#runtime.ops.session.lifecycle.providerCredentialRotated({
      sessionId: this.#getSessionId(),
      payload: input,
    });
  }

  async prepareProviderPayload(input: RuntimeProviderPayloadInput): Promise<unknown> {
    return this.#prepareRuntimeProviderPayload?.(input) ?? input.payload;
  }

  observeCacheRender(input: RuntimeProviderCacheRenderInput): void {
    this.#observeRuntimeCacheRender?.(input);
  }

  observeAssistantMessage(
    message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>,
  ): void {
    this.#onProviderAssistantMessage?.(message);
  }
}
