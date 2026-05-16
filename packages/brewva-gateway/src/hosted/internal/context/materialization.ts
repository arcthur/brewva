import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ProviderCacheObservationInput,
} from "@brewva/brewva-runtime/context";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import {
  recordPromptStabilityEvidence,
  recordProviderCacheObservationEvidence,
} from "./evidence/context-evidence.js";
import type { HostedContextRenderResult } from "./hosted-context-blocks.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import { buildPromptStabilityObservation } from "./prompt-stability.js";

type VisibleReadState = Parameters<
  BrewvaHostedRuntimePort["operator"]["context"]["visibleRead"]["rememberState"]
>[1];

export interface HostedContextMaterializationInput {
  runtime: BrewvaHostedRuntimePort;
  telemetry: HostedContextTelemetry;
  delegationStore?: HostedDelegationStore;
  sessionId: string;
  turn: number;
  contextScopeId?: string;
  systemPrompt: string;
  rendered: HostedContextRenderResult;
  usage?: ContextBudgetUsage;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason: string | null;
  workbenchContextRendered: boolean;
  surfacedDelegationRunIds: readonly string[];
}

export interface HostedContextMaterializationResult {
  effects: string[];
}

function buildContextScopeKey(sessionId: string, contextScopeId?: string): string {
  const normalizedScope = contextScopeId?.trim();
  return normalizedScope ? `${sessionId}::${normalizedScope}` : `${sessionId}::root`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordPromptStability(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  turn: number;
  contextScopeId?: string;
  systemPrompt: string;
  rendered: HostedContextRenderResult;
  usage?: ContextBudgetUsage;
  pendingCompactionReason: string | null;
  gateRequired: boolean;
}): void {
  const observation = buildPromptStabilityObservation({
    systemPrompt: input.systemPrompt,
    composedContent: input.rendered.content,
    contextScopeId: input.contextScopeId,
    turn: input.turn,
  });
  const scopeKey = buildContextScopeKey(input.sessionId, input.contextScopeId);
  const previous = input.runtime.inspect.context.evidence.latest(
    input.sessionId,
    "prompt_stability",
  )?.payload;
  const previousScopeKey = readString(previous?.scopeKey);
  const previousStablePrefixHash = readString(previous?.stablePrefixHash);
  const previousDynamicTailHash = readString(previous?.dynamicTailHash);
  const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey;
  const observed = {
    turn: observation.turn,
    updatedAt: Date.now(),
    scopeKey,
    stablePrefixHash: observation.stablePrefixHash,
    dynamicTailHash: observation.dynamicTailHash,
    stablePrefix:
      previous === undefined ||
      scopeChanged ||
      previousStablePrefixHash === observation.stablePrefixHash,
    stableTail:
      previous === undefined ||
      (previousDynamicTailHash === observation.dynamicTailHash && previousScopeKey === scopeKey),
  };
  input.runtime.operator.context.evidence.append(input.sessionId, {
    kind: "prompt_stability",
    turn: observed.turn,
    timestamp: observed.updatedAt,
    payload: {
      scopeKey: observed.scopeKey,
      stablePrefixHash: observed.stablePrefixHash,
      dynamicTailHash: observed.dynamicTailHash,
      stablePrefix: observed.stablePrefix,
      stableTail: observed.stableTail,
    },
  });
  const contextStatus = input.runtime.inspect.context.usage.getStatus(input.sessionId, input.usage);
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

export function materializeHostedContext(
  input: HostedContextMaterializationInput,
): HostedContextMaterializationResult {
  const effects: string[] = [];

  input.runtime.operator.context.usage.observe(input.sessionId, input.usage);
  effects.push("usage_observed");

  if (input.gateStatus.required) {
    input.telemetry.emitHardGateRequired({
      sessionId: input.sessionId,
      turn: input.turn,
      reason: "hard_limit",
      gateStatus: input.gateStatus,
    });
    effects.push("hard_gate_telemetry_emitted");
  } else if (input.pendingCompactionReason) {
    input.telemetry.emitCompactionAdvisory({
      sessionId: input.sessionId,
      turn: input.turn,
      reason: input.pendingCompactionReason,
      gateStatus: input.gateStatus,
    });
    effects.push("compaction_advisory_telemetry_emitted");
  }

  input.telemetry.emitContextComposed({
    sessionId: input.sessionId,
    turn: input.turn,
    rendered: input.rendered,
    workbenchContextRendered: input.workbenchContextRendered,
  });
  effects.push("context_composed_emitted");

  recordPromptStability({
    runtime: input.runtime,
    sessionId: input.sessionId,
    turn: input.turn,
    contextScopeId: input.contextScopeId,
    systemPrompt: input.systemPrompt,
    rendered: input.rendered,
    usage: input.usage,
    pendingCompactionReason: input.pendingCompactionReason,
    gateRequired: input.gateStatus.required,
  });
  effects.push("prompt_stability_observed");

  if (input.surfacedDelegationRunIds.length > 0) {
    input.delegationStore?.markSurfaced({
      sessionId: input.sessionId,
      turn: input.turn,
      runIds: input.surfacedDelegationRunIds,
    });
    effects.push("delegation_outcome_surfaced");
  }

  return { effects };
}

export function observeHostedProviderCache(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  observation: ProviderCacheObservationInput;
}): HostedContextMaterializationResult {
  const observed = {
    turn: input.observation.turn ?? 0,
    updatedAt: input.observation.timestamp ?? Date.now(),
    source: input.observation.source,
    fingerprint: structuredClone(input.observation.fingerprint),
    render: structuredClone(input.observation.render),
    breakObservation: structuredClone(input.observation.breakObservation),
  };
  input.runtime.operator.context.evidence.append(input.sessionId, {
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
  });
  recordProviderCacheObservationEvidence({
    workspaceRoot: input.runtime.identity.workspaceRoot,
    sessionId: input.sessionId,
    observed,
  });
  return { effects: ["provider_cache_observed"] };
}

export function rememberHostedVisibleReadState(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  state: VisibleReadState;
}): HostedContextMaterializationResult {
  input.runtime.operator.context.visibleRead.rememberState(input.sessionId, input.state);
  return { effects: ["visible_read_state_remembered"] };
}
