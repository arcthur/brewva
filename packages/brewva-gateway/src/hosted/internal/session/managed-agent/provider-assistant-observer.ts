import type { ProviderRequestFingerprint } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type {
  ExpectedProviderCacheBreak,
  ProviderCacheBreakObservation,
  ProviderCacheRenderState,
} from "@brewva/brewva-vocabulary/context";
import { observeHostedProviderCache } from "../../context/materialization.js";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";
import { providerCacheCountersAvailable } from "./provider-cache-state.js";
import type { ProviderCacheObserverView } from "./session-contracts.js";

export interface ManagedSessionProviderAssistantObserverOptions {
  runtime: HostedRuntimeAdapterPort | undefined;
  sessionId: string;
  cacheBreakDetector: {
    observe(input: {
      source: string;
      fingerprint: ProviderRequestFingerprint;
      render?: ProviderCacheRenderState;
      usage: { cacheRead: number; cacheWrite: number };
      expectedBreak: ExpectedProviderCacheBreak | undefined;
      observability: { cacheCountersAvailable: boolean; reason?: string };
      observedAt: number;
    }): ProviderCacheBreakObservation;
  };
  resolveExpectedBreak: () => ExpectedProviderCacheBreak | undefined;
  state: () => ProviderCacheObserverView;
}

export class ManagedSessionProviderAssistantObserver {
  readonly #runtime: HostedRuntimeAdapterPort | undefined;
  readonly #sessionId: string;
  readonly #cacheBreakDetector: ManagedSessionProviderAssistantObserverOptions["cacheBreakDetector"];
  readonly #resolveExpectedBreak: ManagedSessionProviderAssistantObserverOptions["resolveExpectedBreak"];
  readonly #state: ManagedSessionProviderAssistantObserverOptions["state"];

  constructor(options: ManagedSessionProviderAssistantObserverOptions) {
    this.#runtime = options.runtime;
    this.#sessionId = options.sessionId;
    this.#cacheBreakDetector = options.cacheBreakDetector;
    this.#resolveExpectedBreak = options.resolveExpectedBreak;
    this.#state = options.state;
  }

  onCommittedAssistantMessage(message: BrewvaAgentProtocolAssistantMessage): void {
    const state = this.#state();
    if (!this.#runtime || !state.lastProviderFingerprint || !state.lastCacheRender) {
      return;
    }
    const breakObservation = this.#cacheBreakDetector.observe({
      source: state.lastProviderFingerprint.bucketKey,
      fingerprint: state.lastProviderFingerprint,
      render: state.lastCacheRender,
      usage: {
        cacheRead: message.usage.cacheRead ?? 0,
        cacheWrite: message.usage.cacheWrite ?? 0,
      },
      expectedBreak: this.#resolveExpectedBreak(),
      observability: {
        cacheCountersAvailable: providerCacheCountersAvailable(state.lastCacheRender),
        reason: providerCacheCountersAvailable(state.lastCacheRender)
          ? undefined
          : state.lastCacheRender.reason,
      },
      observedAt: Date.now(),
    });
    observeHostedProviderCache({
      runtime: this.#runtime,
      sessionId: this.#sessionId,
      observation: {
        source: state.lastProviderFingerprint.bucketKey,
        fingerprint: state.lastProviderFingerprint,
        render: state.lastCacheRender,
        breakObservation,
      },
    });
  }
}
