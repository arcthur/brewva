import { asLossy } from "@brewva/brewva-std/honesty";
import { resolveWindowScaledTokens } from "@brewva/brewva-substrate/context-budget";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  estimateProviderPayloadTextTokens,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
} from "@brewva/brewva-token-estimation";
import type {
  ContextBudgetUsage,
  ExpectedProviderCacheBreak,
  TransientReductionObservationInput,
} from "@brewva/brewva-vocabulary/context";
import { MESSAGE_END_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  decideTransientReductionEligibility,
  type ContextTransientReductionDecision,
} from "../../context/context-lifecycle.js";
import { recordTransientReductionEvidence } from "../../context/evidence/context-evidence.js";
import {
  getRuntimeCompactionGateStatus,
  getRuntimeContextUsage,
  getRuntimeLifecycleSnapshot,
  getRuntimePendingCompactionReason,
  queryStructuredRuntimeEvents,
  resolveRuntimeContextCompactionEligibility,
  type HostedRuntimeAdapterPort,
} from "../../session/runtime-ports.js";
import { findCatalogModel } from "../model-catalog-lookup.js";
import { isOutputBudgetEscalatedPayload } from "./provider-request-recovery.js";
import { applyTransientOutboundReductionToPayload } from "./provider-request-reduction-walker.js";

const DEFAULT_PROVIDER_CACHE_STALENESS_MS = 5 * 60 * 1000;
const expectedCacheBreakByPayload = new WeakMap<object, ExpectedProviderCacheBreak>();

function asWeakMapKey(value: unknown): object | null {
  return value && typeof value === "object" ? value : null;
}

export function consumeProviderRequestReductionExpectedCacheBreak(
  payload: unknown,
): ExpectedProviderCacheBreak | undefined {
  const key = asWeakMapKey(payload);
  if (!key) {
    return undefined;
  }
  const hint = expectedCacheBreakByPayload.get(key);
  expectedCacheBreakByPayload.delete(key);
  return hint;
}

function rememberProviderRequestReductionExpectedCacheBreak(
  payload: unknown,
  hint: ExpectedProviderCacheBreak | undefined,
): void {
  const key = asWeakMapKey(payload);
  if (!key || !hint) {
    return;
  }
  expectedCacheBreakByPayload.set(key, hint);
}

function resolveUsageRatio(usage: ContextBudgetUsage | undefined): number | null {
  return resolveContextUsageRatio(usage);
}

function resolveUsageTokens(usage: ContextBudgetUsage | undefined): number | null {
  return resolveContextUsageTokens(usage);
}

function resolveUsageContextWindow(usage: ContextBudgetUsage | undefined): number | null {
  return usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? usage.contextWindow
    : null;
}

/**
 * Sessions that never observed provider usage (providers that omit counters)
 * have no runtime context window, which used to leave transient reduction
 * blind. The active model's catalog context window is static metadata and an
 * honest fallback for the estimation path.
 */
function resolveCatalogContextWindow(metadata?: {
  provider?: string;
  modelId?: string;
}): number | null {
  if (!metadata?.provider || !metadata.modelId) {
    return null;
  }
  const model = findCatalogModel(metadata.provider, metadata.modelId);
  return typeof model?.contextWindow === "number" && model.contextWindow > 0
    ? model.contextWindow
    : null;
}

function buildEstimatedPayloadUsage(
  payload: unknown,
  runtimeUsage: ContextBudgetUsage | undefined,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ContextBudgetUsage | undefined {
  const contextWindow =
    resolveUsageContextWindow(runtimeUsage) ?? resolveCatalogContextWindow(metadata);
  if (!contextWindow) {
    return undefined;
  }

  const estimatedTokens = estimateProviderPayloadTextTokens(payload, metadata);
  if (estimatedTokens <= 0) {
    return undefined;
  }

  const usageRatio = Math.max(0, Math.min(1, estimatedTokens / contextWindow));
  return {
    tokens: estimatedTokens,
    contextWindow,
    percent: normalizePercent(usageRatio),
  };
}

interface EffectiveReductionUsage {
  readonly usage: ContextBudgetUsage;
  readonly source: "runtime" | "provider_payload";
}

interface TransientOutboundReductionResolution {
  readonly decision: ContextTransientReductionDecision;
  readonly usage?: ContextBudgetUsage;
}

function hasUsableRuntimeUsage(runtimeUsage: ContextBudgetUsage | undefined): boolean {
  return (
    resolveUsageContextWindow(runtimeUsage) !== null &&
    (resolveUsageTokens(runtimeUsage) !== null || resolveUsageRatio(runtimeUsage) !== null)
  );
}

function buildEffectiveReductionUsage(
  payload: unknown,
  runtimeUsage: ContextBudgetUsage | undefined,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): EffectiveReductionUsage | undefined {
  const estimatedUsage = buildEstimatedPayloadUsage(payload, runtimeUsage, metadata);
  if (!hasUsableRuntimeUsage(runtimeUsage)) {
    return estimatedUsage ? { usage: estimatedUsage, source: "provider_payload" } : undefined;
  }
  if (!estimatedUsage) {
    return { usage: runtimeUsage!, source: "runtime" };
  }

  const runtimeTokens = resolveUsageTokens(runtimeUsage);
  const estimatedTokens = resolveUsageTokens(estimatedUsage);
  if (estimatedTokens !== null && (runtimeTokens === null || estimatedTokens > runtimeTokens)) {
    return { usage: estimatedUsage, source: "provider_payload" };
  }

  const runtimeRatio = resolveUsageRatio(runtimeUsage);
  const estimatedRatio = resolveUsageRatio(estimatedUsage);
  if (estimatedRatio !== null && (runtimeRatio === null || estimatedRatio > runtimeRatio)) {
    return { usage: estimatedUsage, source: "provider_payload" };
  }

  return { usage: runtimeUsage!, source: "runtime" };
}

function getProviderCacheStalenessMs(runtime: HostedRuntimeAdapterPort): number {
  const configured = runtime.config.infrastructure.contextBudget.providerCacheStalenessMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_PROVIDER_CACHE_STALENESS_MS;
}

function isProviderCacheLikelyCold(runtime: HostedRuntimeAdapterPort, sessionId: string): boolean {
  const latestMessageEnd = queryStructuredRuntimeEvents(runtime, sessionId, {
    type: MESSAGE_END_EVENT_TYPE,
  }).at(-1);
  if (!latestMessageEnd) {
    return false;
  }
  return (
    Math.max(0, Date.now() - latestMessageEnd.timestamp) >= getProviderCacheStalenessMs(runtime)
  );
}

function resolveReductionPostureBlockReason(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): string | null {
  const lifecycle = getRuntimeLifecycleSnapshot(runtime, sessionId);
  if (lifecycle.summary.kind === "degraded" || lifecycle.summary.kind === "recovering") {
    return "recovery posture is active";
  }
  if (
    lifecycle.recovery.pendingFamily !== null ||
    lifecycle.recovery.latestStatus === "entered" ||
    lifecycle.execution.kind === "recovering"
  ) {
    return "recovery posture is active";
  }
  if (lifecycle.execution.kind === "waiting_approval") {
    return "approval wait is active";
  }
  return null;
}

function resolveTransientOutboundReduction(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  payload?: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): TransientOutboundReductionResolution {
  const contextBudgetEnabled = runtime.config.infrastructure.contextBudget.enabled;
  const postureBlockReason = contextBudgetEnabled
    ? resolveReductionPostureBlockReason(runtime, sessionId)
    : null;

  const effectiveUsage = contextBudgetEnabled
    ? buildEffectiveReductionUsage(payload, getRuntimeContextUsage(runtime, sessionId), metadata)
    : undefined;
  const usage = effectiveUsage?.usage;

  const gateStatus = usage ? getRuntimeCompactionGateStatus(runtime, sessionId, usage) : null;
  const pendingReason = usage ? getRuntimePendingCompactionReason(runtime, sessionId) : null;
  const eligibility = gateStatus
    ? resolveRuntimeContextCompactionEligibility(runtime, {
        sessionId,
        usage,
        status: gateStatus.status,
        pendingReason,
        recentCompaction: gateStatus.recentCompaction,
        hasUI: true,
        idle: true,
        recoveryPosture: "idle",
        autoCompactionInFlight: false,
        gateMode: "transient_reduction",
      })
    : null;

  const transientReduction = {
    contextBudgetEnabled,
    usageAvailable: usage !== undefined,
    usageSource: effectiveUsage?.source,
    postureBlockReason,
    gateStatus,
    pendingCompactionReason: pendingReason,
    compactionEligibilityDecision:
      typeof eligibility?.decision === "string" ? eligibility.decision : undefined,
    compactionEligibilityReason:
      typeof eligibility?.reason === "string" ? eligibility.reason : undefined,
    cacheCold: usage ? isProviderCacheLikelyCold(runtime, sessionId) : false,
  };

  return {
    decision: decideTransientReductionEligibility(transientReduction),
    usage,
  };
}

export function resolveTransientOutboundReductionEligibility(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  payload?: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ContextTransientReductionDecision {
  return resolveTransientOutboundReduction(runtime, sessionId, payload, metadata).decision;
}

function observeAndRecordTransientReduction(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  input: TransientReductionObservationInput,
): void {
  const observed = {
    turn: input.turn ?? 0,
    updatedAt: input.timestamp ?? Date.now(),
    status: input.status,
    reason: input.reason ?? null,
    eligibleToolResults: Math.max(0, Math.trunc(input.eligibleToolResults)),
    clearedToolResults: Math.max(0, Math.trunc(input.clearedToolResults)),
    clearedChars: Math.max(0, Math.trunc(input.clearedChars ?? 0)),
    estimatedTokenSavings: Math.max(0, Math.trunc(input.estimatedTokenSavings ?? 0)),
    compactionAdvised: input.compactionAdvised ?? false,
    forcedCompaction: input.forcedCompaction ?? false,
    classification: input.classification ?? null,
    expectedCacheBreak: input.expectedCacheBreak ?? false,
  };
  runtime.ops.context.evidence.append(
    sessionId,
    asLossy({
      kind: "transient_reduction",
      turn: observed.turn,
      timestamp: observed.updatedAt,
      payload: {
        status: observed.status,
        reason: observed.reason,
        eligibleToolResults: observed.eligibleToolResults,
        clearedToolResults: observed.clearedToolResults,
        clearedChars: observed.clearedChars,
        estimatedTokenSavings: observed.estimatedTokenSavings,
        compactionAdvised: observed.compactionAdvised,
        forcedCompaction: observed.forcedCompaction,
        classification: observed.classification,
        expectedCacheBreak: observed.expectedCacheBreak,
      },
    }),
  );
  recordTransientReductionEvidence({
    workspaceRoot: runtime.identity.workspaceRoot,
    sessionId,
    observed,
  });
}

export function registerProviderRequestReduction(
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
): void {
  extensionApi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId().trim();
    if (!sessionId) {
      return undefined;
    }

    if (isOutputBudgetEscalatedPayload(event.payload)) {
      observeAndRecordTransientReduction(runtime, sessionId, {
        status: "skipped",
        reason: "output budget recovery requires full request fidelity",
        eligibleToolResults: 0,
        clearedToolResults: 0,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      return undefined;
    }

    const reduction = resolveTransientOutboundReduction(runtime, sessionId, event.payload, {
      provider: event.provider,
      api: event.api,
      modelId: event.modelId,
    });
    const eligibility = reduction.decision;
    if (!eligibility.allowed) {
      observeAndRecordTransientReduction(runtime, sessionId, {
        status: "skipped",
        reason: eligibility.detail,
        eligibleToolResults: 0,
        clearedToolResults: 0,
        compactionAdvised: eligibility.compactionAdvised,
        forcedCompaction: eligibility.forcedCompaction,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      });
      return undefined;
    }

    const compactionConfig = runtime.config.infrastructure.contextBudget.compaction;
    const resolvedTailProtectTokens = resolveWindowScaledTokens(
      compactionConfig.tailProtectTokens,
      compactionConfig.tailProtectRatio,
      reduction.usage?.contextWindow,
    );
    const result = applyTransientOutboundReductionToPayload(
      event.payload,
      {
        provider: event.provider,
        api: event.api,
        modelId: event.modelId,
      },
      {
        protectedTools: compactionConfig.protectedTools,
        ...(resolvedTailProtectTokens !== null
          ? { tailProtectTokens: resolvedTailProtectTokens }
          : {}),
      },
    );
    const expectedBreak: ExpectedProviderCacheBreak | undefined =
      !eligibility.cacheCold && result.status === "completed" && result.clearedToolResults > 0
        ? {
            classification: "prefixResetting",
            reason: result.detail ?? "transient_outbound_reduction",
          }
        : undefined;
    observeAndRecordTransientReduction(runtime, sessionId, {
      status: result.status,
      reason: result.detail,
      eligibleToolResults: result.eligibleToolResults,
      clearedToolResults: result.clearedToolResults,
      clearedChars: result.clearedChars,
      estimatedTokenSavings: result.estimatedTokenSavings,
      compactionAdvised: eligibility.compactionAdvised,
      forcedCompaction: eligibility.forcedCompaction,
      classification:
        result.status === "completed" && result.clearedToolResults > 0
          ? eligibility.cacheCold
            ? "cacheCold"
            : "prefixResetting"
          : "prefixPreserving",
      expectedCacheBreak: expectedBreak !== undefined,
    });
    rememberProviderRequestReductionExpectedCacheBreak(result.payload, expectedBreak);
    return result.status === "completed" ? result.payload : undefined;
  });
}
