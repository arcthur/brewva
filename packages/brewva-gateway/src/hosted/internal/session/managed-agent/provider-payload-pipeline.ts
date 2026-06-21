import type { BrewvaAgentProtocolController } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaHostContext, BrewvaHostPluginRunner } from "@brewva/brewva-substrate/host-api";
import type { ExpectedProviderCacheBreak } from "@brewva/brewva-vocabulary/context";
import { buildHarnessManifest, stableHarnessId } from "@brewva/brewva-vocabulary/harness";
import {
  createProviderRequestFingerprint,
  type ToolSchemaSnapshot,
} from "../../provider/cache/index.js";
import { consumeProviderRequestReductionExpectedCacheBreak } from "../../provider/request/provider-request-reduction.js";
import {
  getRuntimeContextEvidenceLatest,
  getRuntimeVisibleReadEpoch,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
import {
  buildProviderCacheModelKey,
  type ManagedSessionProviderCacheState,
  normalizeProviderCacheRender,
} from "./provider-cache-state.js";
import {
  buildProviderDynamicTailSummary,
  type WorkbenchContextFingerprintInput,
} from "./provider-payload-summary.js";
import type {
  BrewvaManagedAgentSessionSettingsPort,
  ProviderCacheObserverView,
  ProviderCacheRuntimeState,
  RuntimeProviderCacheRenderInput,
  RuntimeProviderPayloadInput,
} from "./session-contracts.js";
import {
  nextHarnessProviderAttemptSequence,
  readHarnessCapabilitySelection,
  readHarnessSkillSelection,
  readProviderFallbackActive,
  recordRuntimeHarnessManifest,
  turnNumberFromTurnId,
} from "./session-harness-manifest.js";

export interface CreateProviderPayloadPipelineOptions {
  readonly runner: Pick<BrewvaHostPluginRunner, "emitBeforeProviderRequest">;
  readonly settings: BrewvaManagedAgentSessionSettingsPort;
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly isSessionReady: () => boolean;
  readonly agentState: () => BrewvaAgentProtocolController["state"];
  readonly createHostContext: () => BrewvaHostContext;
  readonly resolveChannelContext: () => { source: string } | "";
  readonly resolveToolSchemaSnapshot: (invalidationReason: string) => ToolSchemaSnapshot;
  readonly observeStickyLatches: (
    input: Parameters<ManagedSessionProviderCacheState["observeStickyLatches"]>[0],
  ) => ReturnType<ManagedSessionProviderCacheState["observeStickyLatches"]>;
  readonly readWorkbenchContextFingerprint: () => WorkbenchContextFingerprintInput;
}

/**
 * Owns the provider payload preparation pipeline: the before-request plugin
 * mutation, cache-render normalization, request fingerprinting, and per-attempt
 * harness manifest recording. The mutable `providerCacheRuntime` bag and the
 * harness attempt cursors live here as private state so the single instance
 * persists across turns. The session shares the SAME bag with the assistant
 * observer and session-clear path via the exposed accessors.
 */
export class ManagedSessionProviderPayloadPipeline {
  readonly #runner: CreateProviderPayloadPipelineOptions["runner"];
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #runtime: HostedRuntimeAdapterPort;
  readonly #sessionId: string;
  readonly #isSessionReady: CreateProviderPayloadPipelineOptions["isSessionReady"];
  readonly #agentState: CreateProviderPayloadPipelineOptions["agentState"];
  readonly #createHostContext: CreateProviderPayloadPipelineOptions["createHostContext"];
  readonly #resolveChannelContext: CreateProviderPayloadPipelineOptions["resolveChannelContext"];
  readonly #resolveToolSchemaSnapshot: CreateProviderPayloadPipelineOptions["resolveToolSchemaSnapshot"];
  readonly #observeStickyLatches: CreateProviderPayloadPipelineOptions["observeStickyLatches"];
  readonly #readWorkbenchContextFingerprint: CreateProviderPayloadPipelineOptions["readWorkbenchContextFingerprint"];

  readonly #cacheRuntime: ProviderCacheRuntimeState = {
    lastProviderFingerprint: undefined,
    lastCacheRender: undefined,
    lastCacheRenderModelKey: undefined,
    lastExpectedProviderCacheBreak: undefined,
  };
  #harnessProviderAttemptTurnKey: string | undefined;
  #harnessProviderAttemptSequence = 0;

  constructor(options: CreateProviderPayloadPipelineOptions) {
    this.#runner = options.runner;
    this.#settings = options.settings;
    this.#runtime = options.runtime;
    this.#sessionId = options.sessionId;
    this.#isSessionReady = options.isSessionReady;
    this.#agentState = options.agentState;
    this.#createHostContext = options.createHostContext;
    this.#resolveChannelContext = options.resolveChannelContext;
    this.#resolveToolSchemaSnapshot = options.resolveToolSchemaSnapshot;
    this.#observeStickyLatches = options.observeStickyLatches;
    this.#readWorkbenchContextFingerprint = options.readWorkbenchContextFingerprint;
  }

  preparePayload = async ({
    payload,
    model,
    metadata,
    transmittedSecrets,
    turn,
    providerContext,
  }: RuntimeProviderPayloadInput): Promise<unknown> => {
    if (!this.#isSessionReady()) {
      return payload;
    }
    const providerPayloadResult = await this.#runner.emitBeforeProviderRequest(
      {
        type: "before_provider_request",
        payload,
        provider: model.provider,
        api: model.api,
        modelId: model.id,
      },
      this.#createHostContext(),
    );
    const nextPayload = providerPayloadResult.payload;
    this.#cacheRuntime.lastExpectedProviderCacheBreak =
      consumeProviderRequestReductionExpectedCacheBreak(nextPayload);
    const channelContext = this.#resolveChannelContext();
    const cachePolicy = this.#settings.getCachePolicy();
    let cacheRender = normalizeProviderCacheRender({
      metadata,
      model,
      transport: this.#settings.getTransport(),
      sessionId: this.#sessionId,
      cachePolicy,
      previousRender: this.#cacheRuntime.lastCacheRender,
      previousRenderModelKey: this.#cacheRuntime.lastCacheRenderModelKey,
    });
    this.#cacheRuntime.lastCacheRender = cacheRender;
    this.#cacheRuntime.lastCacheRenderModelKey = buildProviderCacheModelKey(model);
    const toolSchemaSnapshot = this.#resolveToolSchemaSnapshot("provider_payload");
    const stickyLatches = this.#observeStickyLatches({
      cachePolicy,
      cacheRender,
      transport: this.#settings.getTransport(),
      reasoning: metadata?.reasoning ?? this.#agentState().thinkingLevel,
      channelContext,
    });
    const transientReduction = getRuntimeContextEvidenceLatest(
      this.#runtime,
      this.#sessionId,
      "transient_reduction",
    )?.payload;
    const visibleHistoryReduction = {
      epoch: getRuntimeVisibleReadEpoch(this.#runtime, this.#sessionId),
      transientReductionStatus:
        transientReduction &&
        typeof transientReduction === "object" &&
        "status" in transientReduction
          ? transientReduction.status
          : "none",
      transientReductionClassification:
        transientReduction &&
        typeof transientReduction === "object" &&
        "classification" in transientReduction
          ? transientReduction.classification
          : null,
      expectedCacheBreak: this.#cacheRuntime.lastExpectedProviderCacheBreak !== undefined,
    };
    const workbenchContext = this.#readWorkbenchContextFingerprint();
    const providerFallback = metadata?.providerFallback ?? { active: false };
    const providerFingerprint = createProviderRequestFingerprint({
      provider: model.provider,
      api: model.api,
      model: model.id,
      transport: this.#settings.getTransport(),
      sessionId: this.#sessionId,
      cachePolicy,
      toolSchemaSnapshot,
      stablePrefixParts: [this.#agentState().systemPrompt],
      dynamicTailParts: [
        buildProviderDynamicTailSummary({
          payload: nextPayload,
          channelContext,
          workbenchContext,
          visibleHistoryReduction,
        }),
      ],
      channelContext,
      renderedCache: cacheRender,
      stickyLatches,
      reasoning: metadata?.reasoning ?? this.#agentState().thinkingLevel,
      thinkingBudgets: metadata?.thinkingBudgets ?? this.#settings.getThinkingBudgets(),
      cacheRelevantHeaders: metadata?.headers,
      extraBody: metadata?.extraBody,
      visibleHistoryReduction,
      workbenchContext,
      providerFallback,
      payload: nextPayload,
      transmittedSecrets,
    });
    this.#cacheRuntime.lastProviderFingerprint = providerFingerprint;
    const harnessManifest = buildHarnessManifest({
      sessionId: this.#sessionId,
      ...(() => {
        const numericTurn = turnNumberFromTurnId(turn.turnId);
        return numericTurn === undefined ? {} : { turn: numericTurn };
      })(),
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      attempt: nextHarnessProviderAttemptSequence({
        turnId: turn.turnId,
        currentTurnKey: this.#harnessProviderAttemptTurnKey,
        currentSequence: this.#harnessProviderAttemptSequence,
        update: (next) => {
          this.#harnessProviderAttemptTurnKey = next.turnKey;
          this.#harnessProviderAttemptSequence = next.sequence;
        },
      }),
      runtime: {
        configHash: stableHarnessId("runtime_config", this.#runtime.config),
        runtimeIdentityHash: stableHarnessId("runtime_identity", this.#runtime.identity),
      },
      prompt: {
        systemPromptHash: providerContext.systemPromptHash,
        blockHashes: providerContext.messageHashes,
        stabilityHash: providerFingerprint.stablePrefixHash,
      },
      tools: {
        activeToolNames: toolSchemaSnapshot.tools.map((tool) => tool.name).toSorted(),
        toolSchemaSnapshotHash: toolSchemaSnapshot.hash,
      },
      skillSelection: readHarnessSkillSelection(this.#runtime, this.#sessionId),
      capabilitySelection: readHarnessCapabilitySelection(this.#runtime, this.#sessionId),
      context: {
        materializationPolicyHash: stableHarnessId("context_materialization_policy", {
          transport: this.#settings.getTransport(),
          cachePolicy,
        }),
        compactionPolicyHash: stableHarnessId("context_compaction_policy", {
          thinkingLevel: metadata?.reasoning ?? this.#agentState().thinkingLevel,
          thinkingBudgets: metadata?.thinkingBudgets ?? this.#settings.getThinkingBudgets(),
          visibleHistoryReduction,
        }),
        promptStablePrefixHash: providerFingerprint.stablePrefixHash,
        promptDynamicTailHash: providerFingerprint.dynamicTailHash,
        contextEvidenceHashes: [
          providerFingerprint.channelContextHash,
          providerFingerprint.visibleHistoryReductionHash,
          providerFingerprint.workbenchContextHash,
        ],
      },
      provider: {
        provider: model.provider,
        api: model.api,
        model: model.id,
        transport: this.#settings.getTransport(),
        cachePolicyHash: providerFingerprint.cachePolicyHash,
        requestHash: providerFingerprint.requestHash,
        providerFallbackHash: providerFingerprint.providerFallbackHash,
        providerFallbackActive: readProviderFallbackActive(providerFallback),
        status: "prepared",
      },
      plugins: {
        mutatingHookIds: providerPayloadResult.mutatingHookIds,
      },
      refs: {
        sourceEventIds: [],
      },
    });
    recordRuntimeHarnessManifest({
      runtime: this.#runtime,
      manifest: harnessManifest,
      turnId: turn.turnId,
    });
    return nextPayload;
  };

  observeCacheRender = ({ render, model }: RuntimeProviderCacheRenderInput): void => {
    this.#cacheRuntime.lastCacheRender = {
      status: render.status,
      reason: render.reason,
      renderedRetention: render.renderedRetention,
      bucketKey: render.bucketKey,
      capability: render.capability,
      cachedContentName: render.cachedContentName,
      cachedContentTtlSeconds: render.cachedContentTtlSeconds,
    };
    this.#cacheRuntime.lastCacheRenderModelKey = buildProviderCacheModelKey(model);
  };

  /**
   * Snapshot of the shared cache runtime bag the assistant observer reads to
   * decide whether a committed assistant message warrants a cache-break check.
   */
  readState(): ProviderCacheObserverView {
    return {
      lastProviderFingerprint: this.#cacheRuntime.lastProviderFingerprint,
      lastCacheRender: this.#cacheRuntime.lastCacheRender,
    };
  }

  /**
   * Consume-ONCE read of the expected provider cache break hint. The next read
   * returns undefined until the payload pipeline records a fresh hint.
   */
  consumeExpectedBreak(): ExpectedProviderCacheBreak | undefined {
    const hint = this.#cacheRuntime.lastExpectedProviderCacheBreak;
    this.#cacheRuntime.lastExpectedProviderCacheBreak = undefined;
    return hint;
  }

  /**
   * Reset the shared bag fields cleared on session clear. Mirrors the legacy
   * `onClear` reset (fingerprint + render + render model key) exactly; the
   * expected-break hint is intentionally NOT reset here, matching prior
   * behavior.
   */
  resetForSessionClear(): void {
    this.#cacheRuntime.lastProviderFingerprint = undefined;
    this.#cacheRuntime.lastCacheRender = undefined;
    this.#cacheRuntime.lastCacheRenderModelKey = undefined;
  }
}

export function createProviderPayloadPipeline(
  options: CreateProviderPayloadPipelineOptions,
): ManagedSessionProviderPayloadPipeline {
  return new ManagedSessionProviderPayloadPipeline(options);
}
