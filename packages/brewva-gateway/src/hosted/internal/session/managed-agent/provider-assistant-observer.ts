import type { ProviderRequestFingerprint } from "@brewva/brewva-provider-core/contracts";
import type {
  BrewvaRuntime,
  ExpectedProviderCacheBreak,
  ProviderCacheBreakObservation,
  ProviderCacheRenderState,
} from "@brewva/brewva-runtime";
import type { BrewvaTurnLoopAssistantMessage } from "@brewva/brewva-substrate/turn";
import { recordProviderCacheObservationEvidence } from "../../context/evidence/context-evidence.js";
import {
  isCachedContentUnsupportedStreamError,
  providerCacheCountersAvailable,
} from "./provider-cache-state.js";

export interface ManagedSessionProviderAssistantObserverState {
  lastProviderFingerprint: ProviderRequestFingerprint | undefined;
  lastCacheRender: ProviderCacheRenderState | undefined;
  lastGoogleModelBaseUrl: string | undefined;
}

export interface ManagedSessionProviderAssistantObserverOptions {
  runtime: BrewvaRuntime | undefined;
  workspaceRoot: string;
  sessionId: string;
  googleCachedContentManager: {
    markUnsupportedFromStreamError(input: {
      workspaceRoot: string;
      modelBaseUrl: string | undefined;
      reason: string;
    }): void;
    observeUsage(input: {
      workspaceRoot: string;
      modelBaseUrl: string | undefined;
      render?: ProviderCacheRenderState;
      cacheRead: number;
    }): void;
  };
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
  state: () => ManagedSessionProviderAssistantObserverState;
}

export class ManagedSessionProviderAssistantObserver {
  readonly #runtime: BrewvaRuntime | undefined;
  readonly #workspaceRoot: string;
  readonly #sessionId: string;
  readonly #googleCachedContentManager: ManagedSessionProviderAssistantObserverOptions["googleCachedContentManager"];
  readonly #cacheBreakDetector: ManagedSessionProviderAssistantObserverOptions["cacheBreakDetector"];
  readonly #resolveExpectedBreak: ManagedSessionProviderAssistantObserverOptions["resolveExpectedBreak"];
  readonly #state: ManagedSessionProviderAssistantObserverOptions["state"];

  constructor(options: ManagedSessionProviderAssistantObserverOptions) {
    this.#runtime = options.runtime;
    this.#workspaceRoot = options.workspaceRoot;
    this.#sessionId = options.sessionId;
    this.#googleCachedContentManager = options.googleCachedContentManager;
    this.#cacheBreakDetector = options.cacheBreakDetector;
    this.#resolveExpectedBreak = options.resolveExpectedBreak;
    this.#state = options.state;
  }

  onCommittedAssistantMessage(message: BrewvaTurnLoopAssistantMessage): void {
    const state = this.#state();
    if (!this.#runtime || !state.lastProviderFingerprint || !state.lastCacheRender) {
      return;
    }
    if (message.api === "google-gemini-cli") {
      if (
        message.stopReason === "error" &&
        typeof message.errorMessage === "string" &&
        isCachedContentUnsupportedStreamError(message.errorMessage)
      ) {
        this.#googleCachedContentManager.markUnsupportedFromStreamError({
          workspaceRoot: this.#workspaceRoot,
          modelBaseUrl: state.lastGoogleModelBaseUrl,
          reason: message.errorMessage,
        });
      } else {
        this.#googleCachedContentManager.observeUsage({
          workspaceRoot: this.#workspaceRoot,
          modelBaseUrl: state.lastGoogleModelBaseUrl,
          render: state.lastCacheRender,
          cacheRead: message.usage.cacheRead ?? 0,
        });
      }
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
    const providerCacheObservation = this.#runtime.maintain.context.observeProviderCache(
      this.#sessionId,
      {
        source: state.lastProviderFingerprint.bucketKey,
        fingerprint: state.lastProviderFingerprint,
        render: state.lastCacheRender,
        breakObservation,
      },
    );
    recordProviderCacheObservationEvidence({
      workspaceRoot: this.#runtime.workspaceRoot,
      sessionId: this.#sessionId,
      observed: providerCacheObservation,
    });
  }
}
