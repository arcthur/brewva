import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  ExpectedProviderCacheBreak,
  TransientReductionObservationInput,
} from "@brewva/brewva-runtime/context";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  estimateProviderPayloadTextTokens,
  normalizePercent,
  resolveContextUsageRatio,
  resolveContextUsageTokens,
} from "@brewva/brewva-token-estimation";
import { recordTransientReductionEvidence } from "../../context/evidence/context-evidence.js";
import { getHostedTurnTransitionCoordinator } from "../../thread-loop/turn-transition.js";
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  MIN_CLEARABLE_TOOL_RESULT_CHARS,
  RECENT_TOOL_RESULT_RETAIN_COUNT,
  applyTransientOutboundReductionToPayload,
} from "./provider-request-reduction-walker.js";

const DEFAULT_PROVIDER_CACHE_STALENESS_MS = 5 * 60 * 1000;
const expectedCacheBreakByPayload = new WeakMap<object, ExpectedProviderCacheBreak>();

interface ReductionEligibility {
  allowed: boolean;
  detail: string | null;
  compactionAdvised: boolean;
  forcedCompaction: boolean;
  cacheCold: boolean;
}

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

function buildEstimatedPayloadUsage(
  payload: unknown,
  runtimeUsage: ContextBudgetUsage | undefined,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ContextBudgetUsage | undefined {
  const contextWindow = resolveUsageContextWindow(runtimeUsage);
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
): ContextBudgetUsage | undefined {
  if (hasUsableRuntimeUsage(runtimeUsage)) {
    return runtimeUsage;
  }
  return buildEstimatedPayloadUsage(payload, runtimeUsage, metadata);
}

function getProviderCacheStalenessMs(runtime: BrewvaHostedRuntimePort): number {
  const configured = runtime.config.infrastructure.contextBudget.providerCacheStalenessMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_PROVIDER_CACHE_STALENESS_MS;
}

function isProviderCacheLikelyCold(runtime: BrewvaHostedRuntimePort, sessionId: string): boolean {
  const latestMessageEnd = runtime.inspect.events.records
    .queryStructured(sessionId, { type: "message_end" })
    .at(-1);
  if (!latestMessageEnd) {
    return false;
  }
  return (
    Math.max(0, Date.now() - latestMessageEnd.timestamp) >= getProviderCacheStalenessMs(runtime)
  );
}

function resolveReductionPostureBlockReason(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): string | null {
  const transitionSnapshot = getHostedTurnTransitionCoordinator(runtime).getSnapshot(sessionId);
  if (transitionSnapshot.pendingFamily === "approval") {
    return "approval wait is active";
  }
  if (
    transitionSnapshot.pendingFamily !== null ||
    transitionSnapshot.latest?.status === "entered"
  ) {
    return "recovery posture is active";
  }

  const lifecycle = runtime.inspect.lifecycle.getSnapshot(sessionId);
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

export function resolveTransientOutboundReductionEligibility(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  payload?: unknown,
  metadata?: {
    provider?: string;
    api?: string;
    modelId?: string;
  },
): ReductionEligibility {
  if (!runtime.config.infrastructure.contextBudget.enabled) {
    return {
      allowed: false,
      detail: "context budget is disabled",
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const postureBlockReason = resolveReductionPostureBlockReason(runtime, sessionId);
  if (postureBlockReason) {
    return {
      allowed: false,
      detail: postureBlockReason,
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const usage = buildEffectiveReductionUsage(
    payload,
    runtime.inspect.context.usage.get(sessionId),
    metadata,
  );
  if (!usage) {
    return {
      allowed: false,
      detail: "context usage is unavailable",
      compactionAdvised: false,
      forcedCompaction: false,
      cacheCold: false,
    };
  }

  const gateStatus = runtime.inspect.context.compaction.getGateStatus(sessionId, usage);
  const cacheCold = isProviderCacheLikelyCold(runtime, sessionId);
  const pendingReason = runtime.inspect.context.compaction.getPendingReason(sessionId);
  const eligibility = runtime.inspect.context.compaction.resolveEligibility({
    status: gateStatus.status,
    pendingReason,
    recentCompaction: gateStatus.recentCompaction,
    hasUI: true,
    idle: true,
    recoveryPosture: "idle",
    autoCompactionInFlight: false,
    autoCompactionBreakerOpen: false,
    gateMode: "transient_reduction",
  });

  const compactionAdvised = gateStatus.status.compactionAdvised;
  const forcedCompaction = gateStatus.status.forcedCompaction;

  if (gateStatus.required || gateStatus.reason === "hard_limit" || forcedCompaction) {
    return {
      allowed: false,
      detail: "hard-limit posture requires replay-visible compaction handling",
      compactionAdvised,
      forcedCompaction,
      cacheCold,
    };
  }

  if (pendingReason === "hard_limit") {
    return {
      allowed: false,
      detail: "hard-limit compaction is already pending",
      compactionAdvised,
      forcedCompaction,
      cacheCold,
    };
  }

  if (eligibility.decision === "skip" && eligibility.reason === "recent_compaction") {
    return {
      allowed: false,
      detail: "recent compaction cooldown is active",
      compactionAdvised,
      forcedCompaction,
      cacheCold,
    };
  }

  if (eligibility.decision === "advisory_only" && compactionAdvised) {
    return {
      allowed: true,
      detail: null,
      compactionAdvised,
      forcedCompaction,
      cacheCold,
    };
  }

  if (cacheCold) {
    return {
      allowed: true,
      detail: null,
      compactionAdvised,
      forcedCompaction,
      cacheCold,
    };
  }

  return {
    allowed: false,
    detail: "context status is below the transient reduction threshold",
    compactionAdvised,
    forcedCompaction,
    cacheCold,
  };
}

function observeAndRecordTransientReduction(
  runtime: BrewvaHostedRuntimePort,
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
  runtime.operator.context.evidence.append(sessionId, {
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
  });
  recordTransientReductionEvidence({
    workspaceRoot: runtime.identity.workspaceRoot,
    sessionId,
    observed,
  });
}

export function registerProviderRequestReduction(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
): void {
  extensionApi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId().trim();
    if (!sessionId) {
      return undefined;
    }

    const eligibility = resolveTransientOutboundReductionEligibility(
      runtime,
      sessionId,
      event.payload,
      {
        provider: event.provider,
        api: event.api,
        modelId: event.modelId,
      },
    );
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

    const result = applyTransientOutboundReductionToPayload(
      event.payload,
      {
        provider: event.provider,
        api: event.api,
        modelId: event.modelId,
      },
      {
        protectedTools: runtime.config.infrastructure.contextBudget.compaction.protectedTools,
        tailProtectTokens: runtime.config.infrastructure.contextBudget.compaction.tailProtectTokens,
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

export const PROVIDER_REQUEST_REDUCTION_TEST_ONLY = {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  MIN_CLEARABLE_TOOL_RESULT_CHARS,
  RECENT_TOOL_RESULT_RETAIN_COUNT,
  applyTransientOutboundReductionToPayload,
  buildEffectiveReductionUsage,
  buildEstimatedPayloadUsage,
  estimatePayloadTextTokens: estimateProviderPayloadTextTokens,
  resolveTransientOutboundReductionEligibility,
  resolveReductionPostureBlockReason,
};
