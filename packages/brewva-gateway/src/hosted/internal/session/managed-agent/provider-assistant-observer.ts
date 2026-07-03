import type { ProviderRequestFingerprint } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import type {
  ExpectedProviderCacheBreak,
  ProviderCacheBreakObservation,
  ProviderCacheRenderState,
} from "@brewva/brewva-vocabulary/context";
import { observeHostedProviderCache } from "../../context/materialization.js";
import { recordRuntimeAssistantCost } from "../projection/runtime-write-adapters.js";
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
  /** Context window of the active model, for context-budget observations. */
  resolveContextWindow?: () => number | null | undefined;
}

export class ManagedSessionProviderAssistantObserver {
  readonly #runtime: HostedRuntimeAdapterPort | undefined;
  readonly #sessionId: string;
  readonly #cacheBreakDetector: ManagedSessionProviderAssistantObserverOptions["cacheBreakDetector"];
  readonly #resolveExpectedBreak: ManagedSessionProviderAssistantObserverOptions["resolveExpectedBreak"];
  readonly #state: ManagedSessionProviderAssistantObserverOptions["state"];
  readonly #resolveContextWindow: ManagedSessionProviderAssistantObserverOptions["resolveContextWindow"];

  constructor(options: ManagedSessionProviderAssistantObserverOptions) {
    this.#runtime = options.runtime;
    this.#sessionId = options.sessionId;
    this.#cacheBreakDetector = options.cacheBreakDetector;
    this.#resolveExpectedBreak = options.resolveExpectedBreak;
    this.#state = options.state;
    this.#resolveContextWindow = options.resolveContextWindow;
  }

  onCommittedAssistantMessage(message: BrewvaAgentProtocolAssistantMessage): void {
    const state = this.#state();
    // A live provider fingerprint distinguishes attempt-committed messages
    // from bootstrap/history replays, which must not re-record usage.
    if (!this.#runtime || !state.lastProviderFingerprint) {
      return;
    }
    this.#recordCommittedUsage(this.#runtime, message);
    if (!state.lastCacheRender) {
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
      toolSchemaEstimatedTokens: state.lastToolSchemaEstimatedTokens,
      observation: {
        source: state.lastProviderFingerprint.bucketKey,
        fingerprint: state.lastProviderFingerprint,
        render: state.lastCacheRender,
        breakObservation,
      },
    });
  }

  #recordCommittedUsage(
    runtime: HostedRuntimeAdapterPort,
    message: BrewvaAgentProtocolAssistantMessage,
  ): void {
    const usage = message.usage;
    const input = usage?.input ?? 0;
    const output = usage?.output ?? 0;
    const cacheRead = usage?.cacheRead ?? 0;
    const cacheWrite = usage?.cacheWrite ?? 0;
    const totalTokens = usage?.totalTokens ?? 0;
    const tokens = totalTokens > 0 ? totalTokens : input + output + cacheRead + cacheWrite;
    if (tokens <= 0) {
      // Providers that report no usage stay silent instead of committing
      // empty cost receipts.
      return;
    }
    recordRuntimeAssistantCost(runtime, {
      sessionId: this.#sessionId,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      ...(usage?.cost ? { cost: { ...usage.cost } } : {}),
      model: `${message.provider}/${message.model}`,
    });
    const contextWindow = this.#resolveContextWindow?.();
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      runtime.ops.context.usage.observe(this.#sessionId, {
        tokens,
        contextWindow,
        percent: null,
        maxOutputTokens: null,
      });
    }
  }
}
