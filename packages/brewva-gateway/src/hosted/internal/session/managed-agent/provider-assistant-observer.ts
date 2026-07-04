import type { ProviderRequestFingerprint } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaAgentProtocolAssistantMessage } from "@brewva/brewva-substrate/agent-protocol";
import { estimateStructuredModelTokens } from "@brewva/brewva-token-estimation";
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
  /**
   * Whether to record a marked token estimate when a live attempt-committed
   * message carries no provider usage. Injected like resolveContextWindow so
   * the observer's config dependency stays explicit and fixture-friendly;
   * absent means disabled (fail closed).
   */
  usageEstimationEnabled?: () => boolean;
}

export class ManagedSessionProviderAssistantObserver {
  readonly #runtime: HostedRuntimeAdapterPort | undefined;
  readonly #sessionId: string;
  readonly #cacheBreakDetector: ManagedSessionProviderAssistantObserverOptions["cacheBreakDetector"];
  readonly #resolveExpectedBreak: ManagedSessionProviderAssistantObserverOptions["resolveExpectedBreak"];
  readonly #state: ManagedSessionProviderAssistantObserverOptions["state"];
  readonly #resolveContextWindow: ManagedSessionProviderAssistantObserverOptions["resolveContextWindow"];
  readonly #usageEstimationEnabled: ManagedSessionProviderAssistantObserverOptions["usageEstimationEnabled"];

  constructor(options: ManagedSessionProviderAssistantObserverOptions) {
    this.#runtime = options.runtime;
    this.#sessionId = options.sessionId;
    this.#cacheBreakDetector = options.cacheBreakDetector;
    this.#resolveExpectedBreak = options.resolveExpectedBreak;
    this.#state = options.state;
    this.#resolveContextWindow = options.resolveContextWindow;
    this.#usageEstimationEnabled = options.usageEstimationEnabled;
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
      // The fingerprint guard already established this as a live
      // attempt-committed message, so missing counters mean the provider
      // omitted usage — not a replay. Record an output estimate marked as
      // such instead of leaving cost and the compaction budget blind. An
      // empty receipt would fake liveness; a marked estimate is physics.
      this.#recordEstimatedUsage(runtime, message);
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

  #recordEstimatedUsage(
    runtime: HostedRuntimeAdapterPort,
    message: BrewvaAgentProtocolAssistantMessage,
  ): void {
    if (this.#usageEstimationEnabled?.() !== true) {
      return;
    }
    // Failed or aborted attempts carry partial content with zeroed counters;
    // estimating those would commit a phantom receipt per retry. Only
    // completed attempts (stop/length/toolUse) are honest estimation targets.
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return;
    }
    const output = estimateStructuredModelTokens(message.content, {
      provider: message.provider,
      modelId: message.model,
    }).tokens;
    if (output <= 0) {
      return;
    }
    recordRuntimeAssistantCost(runtime, {
      sessionId: this.#sessionId,
      output,
      totalTokens: output,
      estimated: true,
      model: `${message.provider}/${message.model}`,
    });
  }
}
