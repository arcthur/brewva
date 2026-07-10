import type { Durable } from "@brewva/brewva-std/honesty";
import type { JsonValue } from "@brewva/brewva-std/json";
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
import { appendProviderDriftSample } from "../../context/materialization.js";
import type {
  PreparedRuntimeProviderPayload,
  ProviderCredentialRotation,
  RuntimeProviderFace,
} from "../../turn/runtime-turn-session.js";
import { readRuntimeVerificationGateEvidenceFromEvent } from "../../turn/runtime-turn-verification-gates.js";
import { queryRuntimeEvents, type HostedRuntimeAdapterPort } from "../runtime-ports.js";
import {
  type BrewvaManagedAgentSessionSettingsPort,
  type RuntimeProviderCacheRenderInput,
  type RuntimeProviderPayloadInput,
} from "./session-contracts.js";
import { readProviderFallbackSelection, turnNumberFromTurnId } from "./session-harness-manifest.js";

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
    | ((input: RuntimeProviderPayloadInput) => Promise<PreparedRuntimeProviderPayload>)
    | undefined;
  readonly #observeRuntimeCacheRender:
    | ((input: RuntimeProviderCacheRenderInput) => void)
    | undefined;
  readonly #onProviderAssistantMessage:
    | ((message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>) => void)
    | undefined;
  // Session-scoped, deliberately NOT persisted: an entitlement can change with a
  // plan upgrade, so a fresh session re-verifies against the provider instead of
  // trusting a stale local verdict. Keyed by `provider/modelId`.
  readonly #unavailableProviderModels = new Map<string, string>();
  // Session-scoped, deliberately NOT persisted and time-boxed: a model that just
  // hit a rate-limit / quota wall is "cooling down" until `untilMs`. Because the
  // active model is re-seeded from the preset every turn, the recovery loop
  // consults this to skip re-dialing a cooling PRIMARY at the next turn's start
  // (and to keep it out of fallback candidates) until its cooldown expires —
  // then it naturally returns. Lazily swept on read so an expired cooldown never
  // strands the user on a fallback. Keyed by `provider/modelId`; value is the
  // expiry epoch-ms.
  readonly #suppressedSelectors = new Map<string, number>();

  constructor(input: {
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    runtime: HostedRuntimeAdapterPort;
    getSessionId: () => string;
    verificationGateManifests: readonly VerificationGateManifest[];
    modelRole?: BrewvaModelRoleAlias;
    getModel: () => BrewvaRegisteredModel | undefined;
    getModelPresetState: () => BrewvaModelPresetState;
    prepareRuntimeProviderPayload?: (
      input: RuntimeProviderPayloadInput,
    ) => Promise<PreparedRuntimeProviderPayload>;
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

  recordProviderCredentialRotated(input: Durable<ProviderCredentialRotation>): void {
    this.#runtime.ops.session.lifecycle.providerCredentialRotated({
      sessionId: this.#getSessionId(),
      payload: input,
    });
  }

  markProviderModelUnavailable(input: {
    readonly provider: string;
    readonly modelId: string;
    readonly reason: string;
  }): void {
    this.#unavailableProviderModels.set(`${input.provider}/${input.modelId}`, input.reason);
  }

  getUnavailableProviderModels(): ReadonlyMap<string, string> {
    return this.#unavailableProviderModels;
  }

  getRetrySettings(): { maxDelayMs: number } | undefined {
    return this.#settings.getRetrySettings();
  }

  suppressSelector(selector: string, untilMs: number): void {
    const existing = this.#suppressedSelectors.get(selector);
    // Keep the later expiry when re-suppressed while still cooling.
    if (existing === undefined || untilMs > existing) {
      this.#suppressedSelectors.set(selector, untilMs);
    }
  }

  getSuppressedSelectors(now: number): ReadonlyMap<string, number> {
    for (const [selector, untilMs] of this.#suppressedSelectors) {
      if (untilMs <= now) {
        this.#suppressedSelectors.delete(selector);
      }
    }
    return this.#suppressedSelectors;
  }

  recordProviderFallbackSelection(input: {
    readonly providerFallback: Record<string, JsonValue>;
    readonly turnId?: string;
  }): void {
    const sample = readProviderFallbackSelection(input.providerFallback);
    if (!sample) {
      return;
    }
    appendProviderDriftSample({
      runtime: this.#runtime,
      sessionId: this.#getSessionId(),
      turn: turnNumberFromTurnId(input.turnId) ?? 0,
      sample,
    });
  }

  async prepareProviderPayload(
    input: RuntimeProviderPayloadInput,
  ): Promise<PreparedRuntimeProviderPayload> {
    return this.#prepareRuntimeProviderPayload?.(input) ?? { payload: input.payload };
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
