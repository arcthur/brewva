import type { BrewvaEventRecord } from "../contracts/index.js";
import { TASK_EVENT_TYPE, coerceTaskLedgerPayload } from "../task/ledger.js";
import { formatTaskVerificationLevelForSurface } from "../task/surface.js";
import { TRUTH_EVENT_TYPE, coerceTruthLedgerPayload } from "../truth/ledger.js";
import { deriveWorkflowArtifactsFromEvent } from "../workflow/derivation.js";
import type {
  ProjectionExtractionResult,
  ProjectionSourceRef,
  ProjectionUnitCandidate,
} from "./types.js";
import { normalizeText } from "./utils.js";

function emptyResult(): ProjectionExtractionResult {
  return {
    upserts: [],
    resolves: [],
  };
}

function normalizeLabelSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function createSourceRef(event: BrewvaEventRecord, evidenceId?: string): ProjectionSourceRef {
  return {
    eventId: event.id,
    eventType: event.type,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    turn: event.turn,
    evidenceId,
  };
}

function dedupeCandidates(candidates: ProjectionUnitCandidate[]): ProjectionUnitCandidate[] {
  const merged = new Map<string, ProjectionUnitCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.sessionId}::${candidate.projectionKey}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...existing,
      label: candidate.label,
      statement: candidate.statement,
      sourceRefs: [...existing.sourceRefs, ...candidate.sourceRefs],
      metadata:
        existing.metadata && candidate.metadata
          ? { ...existing.metadata, ...candidate.metadata }
          : (candidate.metadata ?? existing.metadata),
      status: candidate.status,
    });
  }
  return [...merged.values()];
}

function formatWorkflowProjectionStatement(input: {
  state: string;
  freshness: string;
  summary: string;
}): string {
  return `state=${input.state}; freshness=${input.freshness}; ${input.summary}`;
}

function extractTruth(event: BrewvaEventRecord): ProjectionExtractionResult {
  const payload = coerceTruthLedgerPayload(event.payload);
  if (!payload) return emptyResult();

  if (payload.kind === "fact_resolved") {
    return {
      upserts: [],
      resolves: [
        {
          sessionId: event.sessionId,
          sourceType: "truth_fact",
          sourceId: payload.factId,
          resolvedAt: payload.resolvedAt ?? event.timestamp,
        },
      ],
    };
  }

  const fact = payload.fact;
  const baseRef = createSourceRef(event);
  const evidenceRefs = fact.evidenceIds.map((evidenceId) => createSourceRef(event, evidenceId));
  const candidate: ProjectionUnitCandidate = {
    sessionId: event.sessionId,
    status: fact.status === "resolved" ? "resolved" : "active",
    projectionKey: `truth_fact:${fact.id}`,
    label: `truth.${normalizeLabelSegment(fact.kind) || "fact"}`,
    statement: fact.summary.trim(),
    sourceRefs: [baseRef, ...evidenceRefs],
    metadata: {
      truthFactId: fact.id,
      truthKind: fact.kind,
      severity: fact.severity,
      source: "truth_event",
      projectionGroup: "truth_fact",
    },
  };
  return {
    upserts: candidate.statement ? [candidate] : [],
    resolves: [],
  };
}

function extractTask(event: BrewvaEventRecord): ProjectionExtractionResult {
  const payload = coerceTaskLedgerPayload(event.payload);
  if (!payload) return emptyResult();

  if (payload.kind === "blocker_resolved") {
    return {
      upserts: [],
      resolves: [
        {
          sessionId: event.sessionId,
          sourceType: "task_blocker",
          sourceId: payload.blockerId,
          resolvedAt: event.timestamp,
        },
      ],
    };
  }

  const sourceRef = createSourceRef(event);
  const upserts: ProjectionUnitCandidate[] = [];
  const resolves = [];
  switch (payload.kind) {
    case "spec_set": {
      const keepProjectionKeys: string[] = [];
      const goal = payload.spec.goal.trim();
      if (goal) {
        keepProjectionKeys.push("task_spec.goal");
        upserts.push({
          sessionId: event.sessionId,
          status: "active",
          projectionKey: "task_spec.goal",
          label: "task.goal",
          statement: goal,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
            projectionGroup: "task_spec",
          },
        });
      }
      for (const constraint of payload.spec.constraints ?? []) {
        const normalized = constraint.trim();
        if (!normalized) continue;
        const projectionKey = `task_spec.constraint:${normalizeText(normalized)}`;
        keepProjectionKeys.push(projectionKey);
        upserts.push({
          sessionId: event.sessionId,
          status: "active",
          projectionKey,
          label: "task.constraint",
          statement: normalized,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
            projectionGroup: "task_spec",
          },
        });
      }
      if (payload.spec.verification?.level) {
        const verificationLevel =
          formatTaskVerificationLevelForSurface(payload.spec.verification.level) ??
          payload.spec.verification.level;
        keepProjectionKeys.push("task_spec.verification.level");
        upserts.push({
          sessionId: event.sessionId,
          status: "active",
          projectionKey: "task_spec.verification.level",
          label: "task.verification.level",
          statement: verificationLevel,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
            projectionGroup: "task_spec",
          },
        });
      }
      for (const command of payload.spec.verification?.commands ?? []) {
        const normalized = command.trim();
        if (!normalized) continue;
        const projectionKey = `task_spec.verification.command:${normalizeText(normalized)}`;
        keepProjectionKeys.push(projectionKey);
        upserts.push({
          sessionId: event.sessionId,
          status: "active",
          projectionKey,
          label: "task.verification.command",
          statement: normalized,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
            projectionGroup: "task_spec",
          },
        });
      }
      resolves.push({
        sessionId: event.sessionId,
        sourceType: "projection_group" as const,
        groupKey: "task_spec",
        keepProjectionKeys,
        resolvedAt: event.timestamp,
      });
      break;
    }
    case "blocker_recorded": {
      const message = payload.blocker.message.trim();
      if (!message) break;

      upserts.push({
        sessionId: event.sessionId,
        status: "active",
        projectionKey: `task_blocker:${payload.blocker.id}`,
        label: "task.blocker",
        statement: message,
        sourceRefs: [sourceRef],
        metadata: {
          source: "task_event",
          taskKind: "blocker_recorded",
          taskBlockerId: payload.blocker.id,
          truthFactId: payload.blocker.truthFactId ?? null,
          projectionGroup: "task_blocker",
        },
      });
      break;
    }
    default:
      break;
  }

  return {
    upserts: dedupeCandidates(upserts),
    resolves,
  };
}

function extractWorkflow(event: BrewvaEventRecord): ProjectionExtractionResult {
  const sourceRef = createSourceRef(event);
  const upserts = deriveWorkflowArtifactsFromEvent(event).map(
    (artifact): ProjectionUnitCandidate => ({
      sessionId: event.sessionId,
      status: "active",
      projectionKey: `workflow_artifact:${artifact.kind}`,
      label: `workflow.${artifact.kind}`,
      statement: formatWorkflowProjectionStatement({
        state: artifact.state,
        freshness: artifact.freshness,
        summary: artifact.summary,
      }),
      sourceRefs: [sourceRef],
      metadata: {
        source: "workflow_event",
        projectionGroup: "workflow_artifact",
        workflowKind: artifact.kind,
        workflowState: artifact.state,
        workflowFreshness: artifact.freshness,
        sourceSkillNames: artifact.sourceSkillNames,
        outputKeys: artifact.outputKeys,
      },
    }),
  );

  return {
    upserts: dedupeCandidates(upserts),
    resolves: [],
  };
}

export function extractProjectionFromEvent(event: BrewvaEventRecord): ProjectionExtractionResult {
  if (event.type === TRUTH_EVENT_TYPE) return extractTruth(event);
  if (event.type === TASK_EVENT_TYPE) return extractTask(event);
  const workflow = extractWorkflow(event);
  if (workflow.upserts.length > 0 || workflow.resolves.length > 0) {
    return workflow;
  }
  return emptyResult();
}
