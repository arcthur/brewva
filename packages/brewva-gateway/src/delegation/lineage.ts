import type { ContextAdmission } from "@brewva/brewva-vocabulary/context";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import {
  adoptRuntimeLineageOutcome,
  createRuntimeLineageNode,
  getRuntimeSessionLineageContextEntryPath,
  getRuntimeSessionLineageNode,
  getRuntimeSessionLineageTree,
  recordRuntimeLineageOutcome,
} from "../hosted/api.js";

function isLineageUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("session_lineage_root_missing:");
}

function delegationLineageNodeId(runId: string): string {
  return `lineage:subagent:${runId}`;
}

function delegationOutcomeId(runId: string): string {
  return `lineage:subagent:${runId}:outcome`;
}

function delegationAdoptionId(runId: string): string {
  return `lineage:subagent:${runId}:adoption`;
}

function resolveCurrentLineageNodeId(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): string | undefined {
  try {
    const path = getRuntimeSessionLineageContextEntryPath(runtime, sessionId, {
      includeStateOnly: true,
    });
    const leaf = path.at(-1);
    if (leaf) {
      return leaf.lineageNodeId;
    }
    return getRuntimeSessionLineageTree(runtime, sessionId).rootNodeId ?? undefined;
  } catch (error) {
    if (isLineageUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveDetailsArtifactRef(record: DelegationRunRecord): string | undefined {
  return record.artifactRefs?.find((artifact) => artifact.path)?.path;
}

function resolveOutcomeRef(record: DelegationRunRecord): string {
  return record.workerSessionId
    ? `session:${record.workerSessionId}`
    : `delegation:${record.runId}`;
}

function hasDelegationLineageOutcome(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  lineageNodeId: string;
  outcomeId: string;
}): boolean {
  const node = getRuntimeSessionLineageNode(input.runtime, input.sessionId, input.lineageNodeId);
  return (
    node?.outcomes.some(
      (outcome: { outcomeId?: string }) => outcome.outcomeId === input.outcomeId,
    ) ?? false
  );
}

function hasDelegationLineageAdoption(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  adoptionId: string;
}): boolean {
  const tree = getRuntimeSessionLineageTree(input.runtime, input.sessionId);
  return tree.nodes.some((node: { adoptedOutcomes?: readonly { adoptionId?: string }[] }) =>
    (node.adoptedOutcomes ?? []).some((adoption) => adoption.adoptionId === input.adoptionId),
  );
}

export function ensureDelegationLineageNode(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  record: DelegationRunRecord;
}): string | undefined {
  const lineageNodeId = delegationLineageNodeId(input.record.runId);
  try {
    if (getRuntimeSessionLineageNode(input.runtime, input.sessionId, lineageNodeId)) {
      return lineageNodeId;
    }
  } catch (error) {
    if (isLineageUnavailable(error)) {
      return undefined;
    }
    throw error;
  }

  const parentLineageNodeId = resolveCurrentLineageNodeId(input.runtime, input.sessionId);
  if (!parentLineageNodeId) {
    return undefined;
  }

  try {
    createRuntimeLineageNode(input.runtime, input.sessionId, {
      lineageNodeId,
      parentLineageNodeId,
      kind: input.record.kind ? `subagent.${input.record.kind}` : "subagent",
      forkPoint: {
        kind: "worker_run",
        workerRunId: input.record.runId,
      },
      title: input.record.label ?? input.record.delegate,
      createdBy: "delegation",
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("session_lineage_node_exists:")) {
      return lineageNodeId;
    }
    if (isLineageUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
  return lineageNodeId;
}

export function recordDelegationLineageOutcome(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  record: DelegationRunRecord;
}): string | undefined {
  const lineageNodeId = ensureDelegationLineageNode(input);
  if (!lineageNodeId) {
    return undefined;
  }
  const outcomeId = delegationOutcomeId(input.record.runId);
  if (
    hasDelegationLineageOutcome({
      runtime: input.runtime,
      sessionId: input.sessionId,
      lineageNodeId,
      outcomeId,
    })
  ) {
    return outcomeId;
  }
  recordRuntimeLineageOutcome(input.runtime, input.sessionId, {
    outcomeId,
    lineageNodeId,
    summary: input.record.summary ?? input.record.error ?? `Delegation ${input.record.status}.`,
    admission: "state_only",
    outcomeRef: resolveOutcomeRef(input.record),
    detailsArtifactRef: resolveDetailsArtifactRef(input.record),
  });
  return outcomeId;
}

export function adoptDelegationLineageOutcome(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  record: DelegationRunRecord;
  admission?: ContextAdmission;
}): void {
  const lineageNodeId = ensureDelegationLineageNode(input);
  if (!lineageNodeId) {
    return;
  }
  const targetLineageNodeId = resolveCurrentLineageNodeId(input.runtime, input.sessionId);
  if (!targetLineageNodeId) {
    return;
  }
  const outcomeId = delegationOutcomeId(input.record.runId);
  if (
    !hasDelegationLineageOutcome({
      runtime: input.runtime,
      sessionId: input.sessionId,
      lineageNodeId,
      outcomeId,
    })
  ) {
    recordDelegationLineageOutcome(input);
  }
  const adoptionId = delegationAdoptionId(input.record.runId);
  if (
    hasDelegationLineageAdoption({
      runtime: input.runtime,
      sessionId: input.sessionId,
      adoptionId,
    })
  ) {
    return;
  }
  adoptRuntimeLineageOutcome(input.runtime, input.sessionId, {
    adoptionId,
    outcomeId,
    fromLineageNodeId: lineageNodeId,
    toLineageNodeId: targetLineageNodeId,
    admission: input.admission ?? "context_eligible",
    summary: input.record.summary ?? input.record.error,
  });
}
