import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type { DelegationRunQuery, DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import type {
  ExplorerConsultKind,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentAgent,
  SubagentOutcome,
  SubagentOutcomeArtifactRef,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
} from "@brewva/brewva-tools/contracts";
import { HostedDelegationStore, cloneDelegationRunRecord } from "../delegation-store.js";
import type { HostedDelegationTarget } from "../targets.js";

export function mergeTaskPacket(
  sharedPacket: DelegationPacket | undefined,
  taskPacket: DelegationTaskPacket,
): DelegationPacket {
  const effectCeilingBoundary =
    taskPacket.effectCeiling?.boundary ?? sharedPacket?.effectCeiling?.boundary;
  return {
    objective: taskPacket.objective,
    deliverable: taskPacket.deliverable ?? sharedPacket?.deliverable,
    constraints: [...(sharedPacket?.constraints ?? []), ...(taskPacket.constraints ?? [])],
    sharedNotes: [...(sharedPacket?.sharedNotes ?? []), ...(taskPacket.sharedNotes ?? [])],
    consultBrief: taskPacket.consultBrief ?? sharedPacket?.consultBrief,
    executionHints: {
      preferredTools: [
        ...(sharedPacket?.executionHints?.preferredTools ?? []),
        ...(taskPacket.executionHints?.preferredTools ?? []),
      ],
      fallbackTools: [
        ...(sharedPacket?.executionHints?.fallbackTools ?? []),
        ...(taskPacket.executionHints?.fallbackTools ?? []),
      ],
    },
    contextRefs: [...(sharedPacket?.contextRefs ?? []), ...(taskPacket.contextRefs ?? [])],
    contextBudget: {
      ...sharedPacket?.contextBudget,
      ...taskPacket.contextBudget,
    },
    completionPredicate: taskPacket.completionPredicate ?? sharedPacket?.completionPredicate,
    effectCeiling: effectCeilingBoundary ? { boundary: effectCeilingBoundary } : undefined,
  };
}

export function buildFailureOutcome(input: {
  runId: string;
  agent: SubagentAgent;
  taskName: string;
  taskPath: string;
  nickname: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  consultKind?: ExplorerConsultKind;
  label?: string;
  workerSessionId?: string;
  artifactRefs?: SubagentOutcomeArtifactRef[];
  error: string;
  startedAt: number;
}): SubagentOutcome {
  return {
    ok: false,
    runId: input.runId,
    agent: input.agent,
    taskName: input.taskName,
    taskPath: input.taskPath,
    nickname: input.nickname,
    delegate: input.delegate,
    agentSpec: input.agentSpec,
    envelope: input.envelope,
    skillName: input.skillName,
    ...(input.consultKind ? { consultKind: input.consultKind } : {}),
    label: input.label,
    status: "error",
    workerSessionId: input.workerSessionId,
    error: input.error,
    metrics: {
      durationMs: Math.max(0, Date.now() - input.startedAt),
    },
    artifactRefs: input.artifactRefs,
  };
}

export function resolveDelegationLabel(target: HostedDelegationTarget): string {
  return target.agentSpecName ?? target.envelopeName ?? target.skillName ?? target.name;
}

function summarizeOutcomeForDelivery(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: ${outcome.status} (${outcome.error})`;
  }
  const parts = [
    outcome.kind,
    outcome.workerSessionId ? `worker=${outcome.workerSessionId}` : null,
    typeof outcome.metrics.totalTokens === "number"
      ? `tokens=${outcome.metrics.totalTokens}`
      : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  return `- ${outcome.label ?? outcome.runId}: ${parts.join(" ")}\n  ${outcome.summary}`;
}

function buildDelegationDeliveryContent(input: {
  delegate: string;
  mode: "single";
  outcome: SubagentOutcome;
}): string {
  return [
    `Delegation outcome for delegate=${input.delegate}`,
    `Mode: ${input.mode}`,
    summarizeOutcomeForDelivery(input.outcome),
  ].join("\n");
}

export function buildDeliveryRecordFromRequest(
  delivery: SubagentRunRequest["delivery"] | undefined,
  updatedAt: number,
  defaults: {
    handoffState?: NonNullable<DelegationRunRecord["delivery"]>["handoffState"];
    forceTextOnly?: boolean;
  } = {},
): DelegationRunRecord["delivery"] {
  if (!delivery && !defaults.forceTextOnly) {
    return undefined;
  }
  return {
    mode: delivery?.returnMode ?? "text_only",
    scopeId: delivery?.returnScopeId,
    label: delivery?.returnLabel,
    handoffState: defaults.handoffState ?? "none",
    updatedAt,
  };
}

export interface DelegationDeliveryResult {
  supplementalAppended?: boolean;
  handoffState?: NonNullable<DelegationRunRecord["delivery"]>["handoffState"];
  readyAt?: number;
  surfacedAt?: number;
  updatedAt: number;
}

export function mergeDeliveryRecord(
  delivery: DelegationRunRecord["delivery"] | undefined,
  result: DelegationDeliveryResult | undefined,
): DelegationRunRecord["delivery"] {
  if (!delivery) {
    return undefined;
  }
  if (!result) {
    return delivery;
  }
  return {
    ...delivery,
    supplementalAppended:
      typeof result.supplementalAppended === "boolean"
        ? result.supplementalAppended
        : delivery.supplementalAppended,
    handoffState: result.handoffState ?? delivery.handoffState,
    readyAt: result.readyAt ?? delivery.readyAt,
    surfacedAt: result.surfacedAt ?? delivery.surfacedAt,
    updatedAt: result.updatedAt,
  };
}

export function deliverDelegationOutcome(input: {
  runtime: BrewvaRuntimeRoot;
  sessionId: string;
  delegate: string;
  outcome: SubagentOutcome;
  delivery: NonNullable<SubagentRunRequest["delivery"]>;
}): DelegationDeliveryResult {
  const createdAt = Date.now();
  const content = buildDelegationDeliveryContent({
    delegate: input.delegate,
    mode: "single",
    outcome: input.outcome,
  });
  let supplementalAppended = false;
  if (input.delivery.returnMode === "supplemental") {
    input.runtime.authority.workbench.note(input.sessionId, {
      content,
      sourceRefs: [input.outcome.runId],
      reason: input.delivery.returnScopeId ?? `subagent:${input.delegate}`,
      retentionHint: "session",
    });
    supplementalAppended = true;
  }
  return {
    supplementalAppended,
    updatedAt: createdAt,
  };
}

export function preparePendingParentTurnDelivery(): DelegationDeliveryResult {
  const readyAt = Date.now();
  return {
    handoffState: "pending_parent_turn",
    readyAt,
    supplementalAppended: false,
    updatedAt: readyAt,
  };
}

export function resolveRunRecords(
  delegationStore: HostedDelegationStore,
  sessionId: string,
  query: DelegationRunQuery | undefined,
): DelegationRunRecord[] {
  return delegationStore
    .listRuns(sessionId, query)
    .map((record) => cloneDelegationRunRecord(record));
}

export function createLaunchRunFailure(input: {
  mode: SubagentRunRequest["mode"];
  delegate: string;
  error: string;
}): SubagentRunResult {
  return {
    ok: false,
    mode: input.mode,
    delegate: input.delegate,
    outcomes: [],
    error: input.error,
  };
}

export function createLaunchStartFailure(input: {
  mode: SubagentRunRequest["mode"];
  delegate: string;
  error: string;
}): SubagentStartResult {
  return {
    ok: false,
    mode: input.mode,
    delegate: input.delegate,
    runs: [],
    error: input.error,
  };
}
