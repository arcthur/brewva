import type { JsonValue } from "@brewva/brewva-std/json";
import {
  readDelegationLifecycleEventPayload,
  readVerificationOutcomeRecordedEventPayload,
  readVerificationWriteMarkedEventPayload,
} from "../../../events/descriptors.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "../../../events/registry.js";
import type { BrewvaEventRecord } from "../../../events/types.js";
import { coerceGuardResultPayload, coerceMetricObservationPayload } from "../../events/api.js";
import {
  collectVerificationCoverageTexts,
  collectVerifierCoverageTexts,
} from "./coverage-utils.js";
import {
  compactJsonValue,
  compactText,
  formatPreviewList,
  isRecord,
  readString,
  readStringArray,
  uniqueStrings,
} from "./shared.js";
import type {
  WorkflowArtifact,
  WorkflowArtifactFreshness,
  WorkflowArtifactKind,
  WorkflowArtifactState,
} from "./types.js";

interface WorkflowDraftArtifact {
  artifactId: string;
  sessionId: string;
  kind: Exclude<WorkflowArtifactKind, "ship_posture">;
  summary: string;
  sourceEventIds: string[];
  sourceSkillNames: string[];
  outputKeys: string[];
  producedAt: number;
  freshness: WorkflowArtifactFreshness;
  state: WorkflowArtifactState;
  metadata?: Record<string, JsonValue>;
  writeSide: boolean;
}

function createDraftArtifact(input: {
  event: BrewvaEventRecord;
  kind: WorkflowDraftArtifact["kind"];
  summary: string;
  sourceSkillNames?: readonly string[];
  outputKeys?: readonly string[];
  freshness?: WorkflowArtifactFreshness;
  state?: WorkflowArtifactState;
  metadata?: Record<string, JsonValue>;
  writeSide?: boolean;
}): WorkflowDraftArtifact {
  return {
    artifactId: `wfart:${input.kind}:${input.event.id}`,
    sessionId: input.event.sessionId,
    kind: input.kind,
    summary: compactText(input.summary, 260),
    sourceEventIds: [input.event.id],
    sourceSkillNames: uniqueStrings(input.sourceSkillNames ?? []),
    outputKeys: uniqueStrings(input.outputKeys ?? []),
    producedAt: input.event.timestamp,
    freshness: input.freshness ?? "unknown",
    state: input.state ?? "ready",
    metadata: input.metadata,
    writeSide: input.writeSide === true,
  };
}

function readFirstArrayField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): unknown[] | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function readFirstStringField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractVerificationArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = readVerificationOutcomeRecordedEventPayload(event);
  if (!payload) return [];

  const failedChecks = payload.failedChecks;
  const missingChecks = payload.missingChecks;
  const summaryParts = [`Verification ${payload.outcome} (${payload.level}).`];
  if (failedChecks.length > 0) {
    summaryParts.push(`Failed: ${formatPreviewList(failedChecks)}.`);
  } else if (missingChecks.length > 0) {
    summaryParts.push(`Missing fresh evidence: ${formatPreviewList(missingChecks)}.`);
  } else {
    summaryParts.push(compactText(payload.rootCause, 160));
  }

  return [
    createDraftArtifact({
      event,
      kind: "verification",
      summary: summaryParts.join(" "),
      sourceSkillNames: uniqueStrings([payload.activeSkill ?? ""]),
      outputKeys: ["verification_outcome"],
      freshness:
        payload.evidenceFreshness === "stale" || payload.evidenceFreshness === "mixed"
          ? "stale"
          : "fresh",
      state: payload.outcome === "fail" ? "blocked" : "ready",
      metadata: {
        source: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        outcome: payload.outcome,
        level: payload.level,
        rootCause: payload.rootCause,
        evidenceFreshness: payload.evidenceFreshness,
        failedChecks,
        missingChecks,
        coverageTexts: collectVerificationCoverageTexts(payload),
      },
    }),
  ];
}

function extractWriteMarkedArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = readVerificationWriteMarkedEventPayload(event);
  const toolName = payload?.toolName;
  return [
    createDraftArtifact({
      event,
      kind: "implementation",
      summary: `Workspace mutation observed${toolName ? ` via ${toolName}` : ""}; downstream review and verification may need refresh.`,
      outputKeys: [],
      freshness: "fresh",
      metadata: {
        source: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
        toolName: toolName ?? null,
      },
      writeSide: true,
    }),
  ];
}

function extractWorkerAppliedArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  const workerIds = isRecord(payload) ? readStringArray(payload.workerIds) : [];
  const appliedPaths = isRecord(payload) ? readStringArray(payload.appliedPaths) : [];
  return [
    createDraftArtifact({
      event,
      kind: "worker_patch",
      summary: `Applied worker patch result from ${Math.max(workerIds.length, 1)} worker(s) across ${Math.max(appliedPaths.length, 0)} path(s).`,
      outputKeys: [],
      freshness: "fresh",
      state: "ready",
      metadata: {
        source: WORKER_RESULTS_APPLIED_EVENT_TYPE,
        workerIds,
        appliedPaths,
      },
      writeSide: true,
    }),
  ];
}

function extractWorkerApplyFailedArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  const workerIds = isRecord(payload) ? readStringArray(payload.workerIds) : [];
  const conflicts =
    isRecord(payload) && Array.isArray(payload.conflicts) ? payload.conflicts.length : 0;
  const reason = isRecord(payload) ? readString(payload.reason) : undefined;
  const failedPaths = isRecord(payload) ? readStringArray(payload.failedPaths) : [];
  return [
    createDraftArtifact({
      event,
      kind: "worker_patch",
      summary:
        reason === "merge_conflicts"
          ? `Worker patch apply failed due to merge conflicts (${conflicts} conflict set(s)).`
          : `Worker patch apply failed${reason ? ` (${reason})` : ""}${failedPaths.length > 0 ? ` on ${formatPreviewList(failedPaths)}.` : "."}`,
      outputKeys: [],
      freshness: "fresh",
      state: "blocked",
      metadata: {
        source: WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
        workerIds,
        conflicts,
        reason: reason ?? null,
        failedPaths,
      },
    }),
  ];
}

function extractSubagentPatchArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = readDelegationLifecycleEventPayload(event);
  if (!payload || payload.kind !== "patch") return [];

  const delegate = payload.delegate ?? null;
  const skillName = payload.skillName;
  const summary =
    compactJsonValue(payload.summary, 200) ??
    (event.type === SUBAGENT_COMPLETED_EVENT_TYPE
      ? "Patch worker completed and is awaiting merge/apply."
      : "Patch worker failed.");

  return [
    createDraftArtifact({
      event,
      kind: "worker_patch",
      summary,
      sourceSkillNames: skillName ? [skillName] : [],
      outputKeys: [],
      freshness: "fresh",
      state: event.type === SUBAGENT_COMPLETED_EVENT_TYPE ? "pending" : "blocked",
      metadata: {
        source: event.type,
        delegate,
        runId: payload.runId,
      },
    }),
  ];
}

function extractSubagentVerifierArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = readDelegationLifecycleEventPayload(event);
  if (!payload || payload.kind !== "verifier") return [];

  const delegate = payload.delegate ?? null;
  const skillName = payload.skillName;
  const resultData = payload.resultData;
  const verdict = readFirstStringField(resultData, ["verdict", "verifier_verdict", "qa_verdict"]);
  const checks = readFirstArrayField(resultData, ["checks", "verifier_checks", "qa_checks"]);
  const summary =
    compactJsonValue(payload.summary, 200) ??
    compactJsonValue(checks, 200) ??
    (event.type === SUBAGENT_COMPLETED_EVENT_TYPE
      ? "Delegated Verifier completed."
      : "Delegated Verifier failed.");

  return [
    createDraftArtifact({
      event,
      kind: "verifier",
      summary,
      sourceSkillNames: skillName ? [skillName] : [],
      outputKeys: [
        "verifier_report",
        "verifier_findings",
        "verifier_verdict",
        "verifier_checks",
        "verifier_missing_evidence",
        "verifier_confidence_gaps",
        "verifier_environment_limits",
      ],
      freshness: "fresh",
      state:
        event.type === SUBAGENT_FAILED_EVENT_TYPE
          ? "blocked"
          : verdict === "pass"
            ? "ready"
            : verdict === "fail"
              ? "blocked"
              : "pending",
      metadata: {
        source: event.type,
        delegate,
        runId: payload.runId,
        verifierVerdict: verdict ?? null,
        missingEvidence: readStringArray(
          readFirstArrayField(resultData, [
            "missing_evidence",
            "verifier_missing_evidence",
            "qa_missing_evidence",
          ]),
        ),
        confidenceGaps: readStringArray(
          readFirstArrayField(resultData, [
            "confidence_gaps",
            "verifier_confidence_gaps",
            "qa_confidence_gaps",
          ]),
        ),
        environmentLimits: readStringArray(
          readFirstArrayField(resultData, [
            "environment_limits",
            "verifier_environment_limits",
            "qa_environment_limits",
          ]),
        ),
        coverageTexts: resultData ? collectVerifierCoverageTexts(resultData) : [],
      },
    }),
  ];
}

function extractIterationMetricArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = coerceMetricObservationPayload(event.payload);
  if (!payload) return [];

  const valueText = payload.unit ? `${payload.value} ${payload.unit}` : String(payload.value);
  const summaryParts = [
    `Metric ${payload.metricKey} observed at ${valueText}${payload.aggregation ? ` (${payload.aggregation})` : ""}.`,
  ];
  if (payload.iterationKey) {
    summaryParts.push(`iteration=${payload.iterationKey}.`);
  }
  if (payload.summary) {
    summaryParts.push(compactText(payload.summary, 160));
  }

  return [
    createDraftArtifact({
      event,
      kind: "iteration_metric",
      summary: summaryParts.join(" "),
      outputKeys: ["metric_observation"],
      freshness: "fresh",
      state: "ready",
      metadata: {
        source: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
        factSource: payload.source,
        metricKey: payload.metricKey,
        value: payload.value,
        unit: payload.unit ?? null,
        aggregation: payload.aggregation ?? null,
        iterationKey: payload.iterationKey ?? null,
        evidenceRefs: payload.evidenceRefs,
      },
    }),
  ];
}

function extractIterationGuardArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = coerceGuardResultPayload(event.payload);
  if (!payload) return [];

  const summaryParts = [`Guard ${payload.guardKey} recorded ${payload.status}.`];
  if (payload.iterationKey) {
    summaryParts.push(`iteration=${payload.iterationKey}.`);
  }
  if (payload.summary) {
    summaryParts.push(compactText(payload.summary, 160));
  }

  return [
    createDraftArtifact({
      event,
      kind: "iteration_guard",
      summary: summaryParts.join(" "),
      outputKeys: ["guard_result"],
      freshness: "fresh",
      state:
        payload.status === "fail"
          ? "blocked"
          : payload.status === "inconclusive"
            ? "pending"
            : "ready",
      metadata: {
        source: ITERATION_GUARD_RECORDED_EVENT_TYPE,
        factSource: payload.source,
        guardKey: payload.guardKey,
        status: payload.status,
        iterationKey: payload.iterationKey ?? null,
        evidenceRefs: payload.evidenceRefs,
      },
    }),
  ];
}

export function deriveWorkflowArtifactsFromEvent(event: BrewvaEventRecord): WorkflowArtifact[] {
  const drafts = (() => {
    if (event.type === ITERATION_METRIC_OBSERVED_EVENT_TYPE) {
      return extractIterationMetricArtifact(event);
    }
    if (event.type === ITERATION_GUARD_RECORDED_EVENT_TYPE) {
      return extractIterationGuardArtifact(event);
    }
    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      return extractVerificationArtifact(event);
    }
    if (event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE) {
      return extractWriteMarkedArtifact(event);
    }
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) {
      return extractWorkerAppliedArtifact(event);
    }
    if (event.type === WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE) {
      return extractWorkerApplyFailedArtifact(event);
    }
    if (event.type === SUBAGENT_COMPLETED_EVENT_TYPE || event.type === SUBAGENT_FAILED_EVENT_TYPE) {
      return [...extractSubagentPatchArtifact(event), ...extractSubagentVerifierArtifact(event)];
    }
    return [];
  })();

  return drafts.map((draft) => ({
    artifactId: draft.artifactId,
    sessionId: draft.sessionId,
    kind: draft.kind,
    summary: draft.summary,
    sourceEventIds: draft.sourceEventIds,
    sourceSkillNames: draft.sourceSkillNames,
    outputKeys: draft.outputKeys,
    producedAt: draft.producedAt,
    freshness: draft.freshness,
    state: draft.state,
    metadata: draft.metadata,
  }));
}

export function deriveWorkflowArtifacts(events: readonly BrewvaEventRecord[]): WorkflowArtifact[] {
  const drafts = events
    .toSorted((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id))
    .flatMap((event) => deriveWorkflowArtifactsFromEvent(event))
    .map((artifact) => {
      artifact.supersedesArtifactId = undefined;
      artifact.workspaceRevision = undefined;
      return artifact;
    });

  const latestWriteAt = drafts.reduce((max, artifact) => {
    const source = artifact.metadata?.source;
    const isWriteSide =
      artifact.kind === "implementation" ||
      (artifact.kind === "worker_patch" && source === WORKER_RESULTS_APPLIED_EVENT_TYPE);
    return isWriteSide ? Math.max(max, artifact.producedAt) : max;
  }, 0);
  const latestShipDependencyAt = drafts.reduce((max, artifact) => {
    const source = artifact.metadata?.source;
    const isShipDependency =
      artifact.kind === "implementation" ||
      artifact.kind === "review" ||
      artifact.kind === "verifier" ||
      artifact.kind === "verification" ||
      (artifact.kind === "worker_patch" && source === WORKER_RESULTS_APPLIED_EVENT_TYPE);
    return isShipDependency ? Math.max(max, artifact.producedAt) : max;
  }, 0);

  const byKind = new Map<WorkflowArtifactKind, WorkflowArtifact[]>();
  for (const artifact of drafts) {
    const group = byKind.get(artifact.kind) ?? [];
    group.push(artifact);
    byKind.set(artifact.kind, group);
  }

  for (const group of byKind.values()) {
    group.sort(
      (left, right) =>
        left.producedAt - right.producedAt || left.artifactId.localeCompare(right.artifactId),
    );
    let previousArtifactId: string | undefined;
    for (const [index, artifact] of group.entries()) {
      if (previousArtifactId) {
        artifact.supersedesArtifactId = previousArtifactId;
      }
      previousArtifactId = artifact.artifactId;

      if (index < group.length - 1) {
        artifact.freshness = "stale";
        continue;
      }

      if (
        (artifact.kind === "review" ||
          artifact.kind === "verifier" ||
          artifact.kind === "verification") &&
        latestWriteAt > artifact.producedAt
      ) {
        artifact.freshness = "stale";
        continue;
      }

      if (artifact.kind === "ship" && latestShipDependencyAt > artifact.producedAt) {
        artifact.freshness = "stale";
        continue;
      }

      if (
        (artifact.kind === "design" || artifact.kind === "execution_plan") &&
        latestWriteAt > artifact.producedAt
      ) {
        artifact.freshness = "stale";
        continue;
      }

      if (
        artifact.kind === "discovery" ||
        artifact.kind === "strategy_review" ||
        artifact.kind === "learning_research" ||
        artifact.kind === "design" ||
        artifact.kind === "execution_plan" ||
        artifact.kind === "retro" ||
        artifact.kind === "ship_posture"
      ) {
        artifact.freshness = artifact.freshness === "stale" ? "stale" : "unknown";
        continue;
      }

      if (artifact.freshness !== "stale") {
        artifact.freshness = "fresh";
      }
    }
  }

  return drafts.toSorted(
    (left, right) =>
      right.producedAt - left.producedAt || left.artifactId.localeCompare(right.artifactId),
  );
}

export function latestArtifactByKind(
  artifacts: readonly WorkflowArtifact[],
): Partial<Record<WorkflowArtifactKind, WorkflowArtifact>> {
  const result: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>> = {};
  for (const artifact of artifacts) {
    const existing = result[artifact.kind];
    if (!existing || artifact.producedAt > existing.producedAt) {
      result[artifact.kind] = artifact;
    }
  }
  return result;
}
