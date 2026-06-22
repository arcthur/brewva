import { asLossy } from "@brewva/brewva-std/honesty";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  PromptStabilityState,
  ProviderCacheObservationInput,
  ProviderDriftSample,
} from "@brewva/brewva-vocabulary/context";
import type { ContextBundle } from "../../../context/api.js";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import {
  getRuntimeContextEvidenceLatest,
  getRuntimeContextStatus,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import {
  recordPromptStabilityEvidence,
  recordProviderCacheObservationEvidence,
} from "./evidence/context-evidence.js";
import type { HostedContextRenderResult } from "./hosted-context-blocks.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import { buildPromptStabilityObservation, diffKeyedBlocks } from "./prompt-stability.js";

type VisibleReadState = Parameters<
  HostedRuntimeAdapterPort["ops"]["context"]["visibleRead"]["rememberState"]
>[1];

export interface HostedContextMaterializationInput {
  sessionId: string;
  turn: number;
  contextScopeId?: string;
  systemPrompt: string;
  contextBundle: ContextBundle;
  rendered: HostedContextRenderResult;
  usage?: ContextBudgetUsage;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason: string | null;
  workbenchContextRendered: boolean;
  surfacedDelegationRunIds: readonly string[];
}

export interface ContextMaterializationReceipt {
  sessionId: string;
  turn: number;
  contextScopeId?: string;
  contextBundle: ContextBundle;
  usageObserved: boolean;
  telemetry:
    | { kind: "hard_gate_required"; reason: "hard_limit"; gateStatus: ContextCompactionGateStatus }
    | {
        kind: "compaction_advisory";
        reason: string;
        gateStatus: ContextCompactionGateStatus;
      }
    | null;
  contextComposed: {
    rendered: HostedContextRenderResult;
    workbenchContextRendered: boolean;
  };
  promptStability: ReturnType<typeof buildPromptStabilityObservation>;
  pendingCompactionReason: string | null;
  gateRequired: boolean;
  surfacedDelegationRunIds: string[];
}

function buildContextScopeKey(sessionId: string, contextScopeId?: string): string {
  const normalizedScope = contextScopeId?.trim();
  return normalizedScope ? `${sessionId}::${normalizedScope}` : `${sessionId}::root`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readHashRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, hash] of Object.entries(value)) {
    if (typeof hash === "string") {
      result[key] = hash;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function recordPromptStability(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  contextScopeId?: string;
  observation: ReturnType<typeof buildPromptStabilityObservation>;
  usage?: ContextBudgetUsage;
  pendingCompactionReason: string | null;
  gateRequired: boolean;
}): void {
  const scopeKey = buildContextScopeKey(input.sessionId, input.contextScopeId);
  const previous = getRuntimeContextEvidenceLatest(
    input.runtime,
    input.sessionId,
    "prompt_stability",
  )?.payload;
  const previousScopeKey = readString(previous?.scopeKey);
  const previousStablePrefixHash = readString(previous?.stablePrefixHash);
  const previousDynamicTailHash = readString(previous?.dynamicTailHash);
  const previousTailBlockHashes = readHashRecord(
    (previous as { tailBlockHashes?: unknown } | undefined)?.tailBlockHashes,
  );
  const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey;
  const currentTailBlockHashes = input.observation.tailBlockHashes;
  // Borrowed diff algebra (RFC item A): record the structured per-block change so
  // prefix/tail instability says which block moved, not just that something did.
  // A scope change resets the baseline — the previous scope's blocks are a
  // different surface, so diffing against them would report spurious churn; treat a
  // scope change as no prior baseline. Compute whenever either side is non-empty so
  // an emptied tail (previous had blocks, current has none) reports them all removed
  // instead of silently dropping the removal.
  const tailDiffPrevious = scopeChanged ? undefined : previousTailBlockHashes;
  const tailDiff =
    currentTailBlockHashes || tailDiffPrevious
      ? diffKeyedBlocks(tailDiffPrevious, currentTailBlockHashes ?? {})
      : undefined;
  const changedTailBlocks =
    tailDiff && tailDiff.added.length + tailDiff.updated.length + tailDiff.removed.length > 0
      ? [...tailDiff.added, ...tailDiff.updated, ...tailDiff.removed].toSorted()
      : undefined;
  const observed: PromptStabilityState = {
    turn: input.observation.turn,
    updatedAt: Date.now(),
    scopeKey,
    stablePrefixHash: input.observation.stablePrefixHash,
    dynamicTailHash: input.observation.dynamicTailHash,
    stablePrefix:
      previous === undefined ||
      scopeChanged ||
      previousStablePrefixHash === input.observation.stablePrefixHash,
    stableTail:
      previous === undefined ||
      (previousDynamicTailHash === input.observation.dynamicTailHash &&
        previousScopeKey === scopeKey),
    ...(currentTailBlockHashes ? { tailBlockHashes: currentTailBlockHashes } : {}),
    ...(changedTailBlocks ? { changedTailBlocks } : {}),
  };
  // One computation feeds both the lossy inspect payload and the typed
  // PromptStabilityState recorded below, so "which block changed" reaches the typed
  // evidence path, not just the raw payload (closing RFC item A's evidence consumer).
  input.runtime.ops.context.evidence.append(
    input.sessionId,
    asLossy({
      kind: "prompt_stability",
      turn: observed.turn,
      timestamp: observed.updatedAt,
      payload: {
        scopeKey: observed.scopeKey,
        stablePrefixHash: observed.stablePrefixHash,
        dynamicTailHash: observed.dynamicTailHash,
        stablePrefix: observed.stablePrefix,
        stableTail: observed.stableTail,
        ...(currentTailBlockHashes ? { tailBlockHashes: currentTailBlockHashes } : {}),
        ...(changedTailBlocks ? { changedTailBlocks } : {}),
      },
    }),
  );
  const contextStatus = getRuntimeContextStatus(input.runtime, input.sessionId, input.usage);
  recordPromptStabilityEvidence({
    workspaceRoot: input.runtime.identity.workspaceRoot,
    sessionId: input.sessionId,
    observed,
    compactionAdvised: contextStatus.compactionAdvised,
    forcedCompaction: contextStatus.forcedCompaction,
    usageRatio: contextStatus.usageRatio,
    pendingCompactionReason: input.pendingCompactionReason,
    gateRequired: input.gateRequired,
  });
}

export function buildContextMaterializationReceipt(
  input: HostedContextMaterializationInput,
): ContextMaterializationReceipt {
  const telemetry = input.gateStatus.required
    ? ({ kind: "hard_gate_required", reason: "hard_limit", gateStatus: input.gateStatus } as const)
    : input.pendingCompactionReason
      ? ({
          kind: "compaction_advisory",
          reason: input.pendingCompactionReason,
          gateStatus: input.gateStatus,
        } as const)
      : null;
  return {
    sessionId: input.sessionId,
    turn: input.turn,
    contextScopeId: input.contextScopeId,
    contextBundle: input.contextBundle,
    usageObserved: true,
    telemetry,
    contextComposed: {
      rendered: input.rendered,
      workbenchContextRendered: input.workbenchContextRendered,
    },
    promptStability: buildPromptStabilityObservation({
      systemPrompt: input.systemPrompt,
      composedContent: input.rendered.content,
      contextScopeId: input.contextScopeId,
      turn: input.turn,
      tailBlocks: input.rendered.blocks,
    }),
    pendingCompactionReason: input.pendingCompactionReason,
    gateRequired: input.gateStatus.required ?? false,
    surfacedDelegationRunIds: [...input.surfacedDelegationRunIds],
  };
}

export function applyContextMaterializationReceipt(input: {
  runtime: HostedRuntimeAdapterPort;
  telemetry: HostedContextTelemetry;
  delegationStore?: HostedDelegationStore;
  receipt: ContextMaterializationReceipt;
  usage?: ContextBudgetUsage;
}): void {
  const { receipt } = input;
  if (receipt.usageObserved) {
    input.runtime.ops.context.usage.observe(receipt.sessionId, input.usage);
  }

  if (receipt.telemetry?.kind === "hard_gate_required") {
    input.telemetry.emitHardGateRequired({
      sessionId: receipt.sessionId,
      turn: receipt.turn,
      reason: receipt.telemetry.reason,
      gateStatus: receipt.telemetry.gateStatus,
    });
  } else if (receipt.telemetry?.kind === "compaction_advisory") {
    input.telemetry.emitCompactionAdvisory({
      sessionId: receipt.sessionId,
      turn: receipt.turn,
      reason: receipt.telemetry.reason,
      gateStatus: receipt.telemetry.gateStatus,
    });
  }

  input.telemetry.emitContextComposed({
    sessionId: receipt.sessionId,
    turn: receipt.turn,
    rendered: receipt.contextComposed.rendered,
    workbenchContextRendered: receipt.contextComposed.workbenchContextRendered,
  });

  recordPromptStability({
    runtime: input.runtime,
    sessionId: receipt.sessionId,
    contextScopeId: receipt.contextScopeId,
    observation: receipt.promptStability,
    usage: input.usage,
    pendingCompactionReason: receipt.pendingCompactionReason,
    gateRequired: receipt.gateRequired,
  });

  if (receipt.surfacedDelegationRunIds.length > 0) {
    input.delegationStore?.markSurfaced({
      sessionId: receipt.sessionId,
      turn: receipt.turn,
      runIds: receipt.surfacedDelegationRunIds,
    });
  }
}

// One provider-drift primitive: cache breaks, fallback selections, and (follow-up)
// transport fallbacks all surface through the SAME lossy evidence sink, so one
// inspect view can read them through one path. A drift sample is a non-authoritative
// diagnosis — never replay truth, may vanish on restart by design.
export function appendProviderDriftSample(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  turn: number;
  sample: ProviderDriftSample;
}): void {
  const { sample } = input;
  input.runtime.ops.context.evidence.append(
    input.sessionId,
    asLossy({
      kind: "provider_drift_sample",
      turn: input.turn,
      timestamp: Date.now(),
      payload: {
        driftSource: sample.source,
        provider: sample.provider,
        reason: sample.reason,
        ...(sample.selected ? { model: sample.selected.model } : {}),
        ...(sample.attempted
          ? { attemptedProvider: sample.attempted.provider, attemptedModel: sample.attempted.model }
          : {}),
        ...(sample.selected?.credentialSlot
          ? { credentialSlot: sample.selected.credentialSlot }
          : {}),
        ...(sample.requestedTransport ? { requestedTransport: sample.requestedTransport } : {}),
        ...(sample.actualTransport ? { actualTransport: sample.actualTransport } : {}),
      },
    }),
  );
}

export function observeHostedProviderCache(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  observation: ProviderCacheObservationInput;
}): void {
  const observed = {
    turn: input.observation.turn ?? 0,
    updatedAt: input.observation.timestamp ?? Date.now(),
    source: input.observation.source,
    fingerprint: structuredClone(input.observation.fingerprint),
    render: structuredClone(input.observation.render),
    breakObservation: structuredClone(input.observation.breakObservation),
  };
  // The cache-break observation is lossy by contract: latest-per-kind state that
  // does not survive restart and is never replay authority. Tag it `Lossy` so the
  // type system keeps it out of any durable sink.
  input.runtime.ops.context.evidence.append(
    input.sessionId,
    asLossy({
      kind: "provider_cache_observation",
      turn: observed.turn,
      timestamp: observed.updatedAt,
      payload: {
        source: observed.source,
        bucketKey: observed.fingerprint.bucketKey,
        stablePrefixHash: observed.fingerprint.stablePrefixHash,
        dynamicTailHash: observed.fingerprint.dynamicTailHash,
        visibleHistoryReductionHash: observed.fingerprint.visibleHistoryReductionHash,
        workbenchContextHash: observed.fingerprint.workbenchContextHash,
        status: observed.breakObservation.status,
        classification: observed.breakObservation.classification,
        expected: observed.breakObservation.expected,
        reason: observed.breakObservation.reason,
        cacheReadTokens: observed.breakObservation.cacheReadTokens,
        cacheWriteTokens: observed.breakObservation.cacheWriteTokens,
        cacheMissTokens: observed.breakObservation.cacheMissTokens,
        changedFields: [...observed.breakObservation.changedFields],
      },
    }),
  );
  recordProviderCacheObservationEvidence({
    workspaceRoot: input.runtime.identity.workspaceRoot,
    sessionId: input.sessionId,
    observed,
  });
}

export function rememberHostedVisibleReadState(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  state: VisibleReadState;
}): void {
  input.runtime.ops.context.visibleRead.rememberState(input.sessionId, input.state);
}
