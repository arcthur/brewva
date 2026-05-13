import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import type { ContextAdmission } from "@brewva/brewva-runtime/session";

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
  runtime: BrewvaRuntime,
  sessionId: string,
): string | undefined {
  try {
    const path = runtime.inspect.session.lineage.getContextEntryPath(sessionId, {
      includeStateOnly: true,
    });
    const leaf = path.at(-1);
    if (leaf) {
      return leaf.lineageNodeId;
    }
    return runtime.inspect.session.lineage.getTree(sessionId).rootNodeId;
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
  runtime: BrewvaRuntime;
  sessionId: string;
  lineageNodeId: string;
  outcomeId: string;
}): boolean {
  const node = input.runtime.inspect.session.lineage.getNode(input.sessionId, input.lineageNodeId);
  return node?.outcomes.some((outcome) => outcome.outcomeId === input.outcomeId) ?? false;
}

function hasDelegationLineageAdoption(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  adoptionId: string;
}): boolean {
  const tree = input.runtime.inspect.session.lineage.getTree(input.sessionId);
  return tree.nodes.some((node) =>
    node.adoptedOutcomes.some((adoption) => adoption.adoptionId === input.adoptionId),
  );
}

export function ensureDelegationLineageNode(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  record: DelegationRunRecord;
}): string | undefined {
  const lineageNodeId = delegationLineageNodeId(input.record.runId);
  try {
    if (input.runtime.inspect.session.lineage.getNode(input.sessionId, lineageNodeId)) {
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
    input.runtime.authority.session.lineage.createNode(input.sessionId, {
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
  runtime: BrewvaRuntime;
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
  input.runtime.authority.session.lineage.recordOutcome(input.sessionId, {
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
  runtime: BrewvaRuntime;
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
  input.runtime.authority.session.lineage.adoptOutcome(input.sessionId, {
    adoptionId,
    outcomeId,
    fromLineageNodeId: lineageNodeId,
    toLineageNodeId: targetLineageNodeId,
    admission: input.admission ?? "context_eligible",
    summary: input.record.summary ?? input.record.error,
  });
}
