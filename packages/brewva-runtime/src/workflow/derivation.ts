import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "../events/event-types.js";
import type { BrewvaEventRecord } from "../types.js";
import type { JsonValue } from "../utils/json.js";

export const WORKFLOW_ARTIFACT_KINDS = [
  "design",
  "execution_plan",
  "implementation",
  "review",
  "verification",
  "worker_patch",
  "release_readiness",
] as const;

export type WorkflowArtifactKind = (typeof WORKFLOW_ARTIFACT_KINDS)[number];
export type WorkflowArtifactFreshness = "fresh" | "stale" | "unknown";
export type WorkflowArtifactState = "ready" | "blocked" | "pending";
export type WorkflowLaneStatus = "missing" | "ready" | "stale" | "blocked";
export type WorkflowPlanningStatus = "missing" | "ready";
export type WorkflowImplementationStatus = "missing" | "pending" | "ready" | "blocked";

export interface WorkflowArtifact {
  artifactId: string;
  sessionId: string;
  kind: WorkflowArtifactKind;
  summary: string;
  sourceEventIds: string[];
  sourceSkillNames: string[];
  outputKeys: string[];
  producedAt: number;
  supersedesArtifactId?: string;
  freshness: WorkflowArtifactFreshness;
  state: WorkflowArtifactState;
  workspaceRevision?: string;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowReadiness {
  sessionId: string;
  planning: WorkflowPlanningStatus;
  implementation: WorkflowImplementationStatus;
  review: WorkflowLaneStatus;
  verification: WorkflowLaneStatus;
  release: Exclude<WorkflowLaneStatus, "stale">;
  blockers: string[];
  latestArtifactIds: string[];
  updatedAt: number;
}

export interface WorkflowStatusSnapshot {
  sessionId: string;
  currentWorkspaceRevision?: string;
  readiness: WorkflowReadiness;
  artifacts: WorkflowArtifact[];
  pendingWorkerResults: number;
  updatedAt: number;
}

interface WorkflowDraftArtifact {
  artifactId: string;
  sessionId: string;
  kind: Exclude<WorkflowArtifactKind, "release_readiness">;
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

interface TaskBlockerLike {
  id: string;
  message: string;
}

interface DeriveWorkflowStatusInput {
  sessionId: string;
  events: readonly BrewvaEventRecord[];
  blockers?: readonly TaskBlockerLike[];
  pendingWorkerResults?: number;
  workspaceRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (isRecord(entry)) {
        return readString(entry.path) ?? readString(entry.file) ?? readString(entry.name) ?? "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
}

function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function compactJsonValue(value: unknown, maxChars = 220): string | undefined {
  if (typeof value === "string") {
    return compactText(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const pieces = value
      .map((entry) => compactJsonValue(entry, Math.max(40, Math.floor(maxChars / 3))))
      .filter((entry): entry is string => Boolean(entry));
    if (pieces.length === 0) return undefined;
    return compactText(pieces.join("; "), maxChars);
  }
  if (isRecord(value)) {
    try {
      return compactText(JSON.stringify(value), maxChars);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatPreviewList(values: readonly string[], limit = 3): string {
  if (values.length === 0) return "none";
  const preview = values.slice(0, limit);
  if (values.length <= limit) return preview.join(", ");
  return `${preview.join(", ")} (+${values.length - limit} more)`;
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

function extractSkillCompletedArtifacts(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  if (!isRecord(payload)) return [];
  const outputs = isRecord(payload.outputs) ? payload.outputs : undefined;
  if (!outputs) return [];

  const skillName = readString(payload.skillName);
  const outputKeys = uniqueStrings([
    ...readStringArray(payload.outputKeys),
    ...Object.keys(outputs).map((key) => key.trim()),
  ]);
  const drafts: WorkflowDraftArtifact[] = [];
  const designSpec = outputs.design_spec;
  if (designSpec !== undefined) {
    drafts.push(
      createDraftArtifact({
        event,
        kind: "design",
        summary: compactJsonValue(designSpec) ?? "Design artifact recorded.",
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["design_spec"],
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
        },
      }),
    );
  }

  const executionPlan = outputs.execution_plan;
  if (executionPlan !== undefined) {
    const planSteps = readStringArray(executionPlan);
    const summary =
      planSteps.length > 0
        ? `Execution plan with ${planSteps.length} step(s): ${formatPreviewList(planSteps)}.`
        : (compactJsonValue(executionPlan) ?? "Execution plan recorded.");
    drafts.push(
      createDraftArtifact({
        event,
        kind: "execution_plan",
        summary,
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["execution_plan"],
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          stepCount: planSteps.length,
        },
      }),
    );
  }

  const changeSet = outputs.change_set;
  const filesChanged = readStringArray(outputs.files_changed);
  if (changeSet !== undefined || filesChanged.length > 0) {
    const summary =
      filesChanged.length > 0
        ? `Implementation changed ${filesChanged.length} file(s): ${formatPreviewList(filesChanged)}.`
        : (compactJsonValue(changeSet) ?? "Implementation artifact recorded.");
    drafts.push(
      createDraftArtifact({
        event,
        kind: "implementation",
        summary,
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["change_set", "files_changed"].filter((key) => outputs[key] !== undefined),
        freshness: "fresh",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          filesChanged,
        },
        writeSide: true,
      }),
    );
  }

  const reviewReport = outputs.review_report;
  const reviewFindings = outputs.review_findings;
  const mergeDecision = readString(outputs.merge_decision);
  if (reviewReport !== undefined || reviewFindings !== undefined || mergeDecision) {
    const reviewSummaryParts = [];
    if (mergeDecision) {
      reviewSummaryParts.push(`decision=${mergeDecision}`);
    }
    const reviewText =
      compactJsonValue(reviewReport) ??
      compactJsonValue(reviewFindings) ??
      "Review artifact recorded.";
    reviewSummaryParts.push(reviewText);
    drafts.push(
      createDraftArtifact({
        event,
        kind: "review",
        summary: reviewSummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["review_report", "review_findings", "merge_decision"].filter(
          (key) => outputs[key] !== undefined,
        ),
        freshness: "fresh",
        state: mergeDecision && mergeDecision !== "ready" ? "blocked" : "ready",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          mergeDecision: mergeDecision ?? null,
        },
      }),
    );
  }

  return drafts;
}

function extractVerificationArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  if (!isRecord(payload)) return [];

  const outcome = readString(payload.outcome);
  if (!outcome) return [];
  const level = readString(payload.level);
  const failedChecks = readStringArray(payload.failedChecks);
  const evidenceFreshness = readString(payload.evidenceFreshness);
  const summaryParts = [`Verification ${outcome}${level ? ` (${level})` : ""}.`];
  if (failedChecks.length > 0) {
    summaryParts.push(`Failed: ${formatPreviewList(failedChecks)}.`);
  } else if (readString(payload.rootCause)) {
    summaryParts.push(compactText(readString(payload.rootCause) ?? "", 160));
  }

  return [
    createDraftArtifact({
      event,
      kind: "verification",
      summary: summaryParts.join(" "),
      sourceSkillNames: uniqueStrings([readString(payload.activeSkill) ?? ""]),
      outputKeys: ["verification_outcome"],
      freshness: evidenceFreshness === "stale" || evidenceFreshness === "mixed" ? "stale" : "fresh",
      state: outcome === "fail" ? "blocked" : "ready",
      metadata: {
        source: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        outcome,
        level: level ?? null,
        evidenceFreshness: evidenceFreshness ?? null,
        failedChecks,
      },
    }),
  ];
}

function extractWriteMarkedArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  const toolName = isRecord(payload) ? readString(payload.toolName) : undefined;
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
  const payload = event.payload;
  if (!isRecord(payload)) return [];
  if (readString(payload.kind) !== "patch") return [];

  const profile = readString(payload.profile);
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
      sourceSkillNames: profile ? [profile] : [],
      outputKeys: [],
      freshness: "fresh",
      state: event.type === SUBAGENT_COMPLETED_EVENT_TYPE ? "pending" : "blocked",
      metadata: {
        source: event.type,
        profile: profile ?? null,
        runId: readString(payload.runId) ?? null,
      },
    }),
  ];
}

export function deriveWorkflowArtifactsFromEvent(event: BrewvaEventRecord): WorkflowArtifact[] {
  const drafts = (() => {
    if (event.type === "skill_completed") return extractSkillCompletedArtifacts(event);
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
      return extractSubagentPatchArtifact(event);
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
        (artifact.kind === "review" || artifact.kind === "verification") &&
        latestWriteAt > artifact.producedAt
      ) {
        artifact.freshness = "stale";
        continue;
      }

      if (
        artifact.kind === "design" ||
        artifact.kind === "execution_plan" ||
        artifact.kind === "release_readiness"
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

function latestArtifactByKind(
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

function determinePlanningStatus(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
): WorkflowPlanningStatus {
  const candidates = [latestArtifacts.design, latestArtifacts.execution_plan].filter(
    (artifact): artifact is WorkflowArtifact => Boolean(artifact),
  );
  if (candidates.length === 0) return "missing";
  return "ready";
}

function determineImplementationStatus(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
): WorkflowImplementationStatus {
  const candidates = [latestArtifacts.implementation, latestArtifacts.worker_patch].filter(
    (artifact): artifact is WorkflowArtifact => Boolean(artifact),
  );
  if (candidates.length === 0) return "missing";

  const latest = candidates.toSorted((left, right) => right.producedAt - left.producedAt)[0]!;
  if (latest.state === "blocked") return "blocked";
  if (latest.state === "pending") return "pending";
  return "ready";
}

function determineLaneStatus(
  artifact: WorkflowArtifact | undefined,
  missingStatus: WorkflowLaneStatus = "missing",
): WorkflowLaneStatus {
  if (!artifact) return missingStatus;
  if (artifact.state === "blocked") return "blocked";
  if (artifact.freshness === "stale") return "stale";
  return "ready";
}

function dedupeBlockers(blockers: readonly string[]): string[] {
  return [...new Set(blockers.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function createReleaseArtifact(input: {
  sessionId: string;
  updatedAt: number;
  currentWorkspaceRevision?: string;
  readiness: WorkflowReadiness;
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>;
}): WorkflowArtifact {
  const latestCoreArtifacts = [
    input.latestArtifacts.design,
    input.latestArtifacts.execution_plan,
    input.latestArtifacts.implementation,
    input.latestArtifacts.review,
    input.latestArtifacts.verification,
    input.latestArtifacts.worker_patch,
  ].filter((artifact): artifact is WorkflowArtifact => Boolean(artifact));

  const sourceEventIds = uniqueStrings(
    latestCoreArtifacts.flatMap((artifact) => artifact.sourceEventIds),
  );
  const sourceSkillNames = uniqueStrings(
    latestCoreArtifacts.flatMap((artifact) => artifact.sourceSkillNames),
  );

  const blockerPreview =
    input.readiness.blockers.length > 0
      ? ` Blockers: ${formatPreviewList(input.readiness.blockers, 2)}.`
      : "";
  const summary = `Release readiness is ${input.readiness.release}.${blockerPreview}`;

  return {
    artifactId: `wfart:release_readiness:${input.sessionId}:${input.updatedAt}`,
    sessionId: input.sessionId,
    kind: "release_readiness",
    summary,
    sourceEventIds,
    sourceSkillNames,
    outputKeys: [],
    producedAt: input.updatedAt,
    freshness:
      input.readiness.release === "ready"
        ? "fresh"
        : input.readiness.review === "stale" || input.readiness.verification === "stale"
          ? "stale"
          : "unknown",
    state:
      input.readiness.release === "ready"
        ? "ready"
        : input.readiness.release === "blocked"
          ? "blocked"
          : "pending",
    workspaceRevision: input.currentWorkspaceRevision,
    metadata: {
      source: "workflow_status",
      release: input.readiness.release,
      blockers: input.readiness.blockers,
    },
  };
}

function readPackedRef(gitDir: string, refName: string): string | undefined {
  const packedRefsPath = join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) return undefined;
  try {
    const lines = readFileSync(packedRefsPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
      const [hash, name] = trimmed.split(" ", 2);
      if (name === refName && readString(hash)) {
        return hash;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveGitDir(workspaceRoot: string): string | undefined {
  const dotGit = join(resolve(workspaceRoot), ".git");
  if (!existsSync(dotGit)) return undefined;
  try {
    const stats = statSync(dotGit);
    if (stats.isDirectory()) {
      return dotGit;
    }
    if (!stats.isFile()) return undefined;
    const contents = readFileSync(dotGit, "utf8");
    const match = contents.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match?.[1]) return undefined;
    return resolve(workspaceRoot, match[1].trim());
  } catch {
    return undefined;
  }
}

export function resolveWorkspaceRevision(workspaceRoot: string): string | undefined {
  const gitDir = resolveGitDir(workspaceRoot);
  if (!gitDir) return undefined;
  const headPath = join(gitDir, "HEAD");
  if (!existsSync(headPath)) return undefined;
  try {
    const head = readFileSync(headPath, "utf8").trim();
    if (!head) return undefined;
    if (!head.startsWith("ref:")) {
      return head;
    }
    const refName = head.slice("ref:".length).trim();
    if (!refName) return undefined;
    const refPath = join(gitDir, refName);
    if (existsSync(refPath)) {
      return readString(readFileSync(refPath, "utf8")) ?? undefined;
    }
    return readPackedRef(gitDir, refName);
  } catch {
    return undefined;
  }
}

export function deriveWorkflowStatus(input: DeriveWorkflowStatusInput): WorkflowStatusSnapshot {
  const currentWorkspaceRevision = input.workspaceRoot
    ? resolveWorkspaceRevision(input.workspaceRoot)
    : undefined;
  const artifacts = deriveWorkflowArtifacts(input.events);
  const latestArtifacts = latestArtifactByKind(artifacts);
  const taskBlockers = input.blockers ?? [];
  const pendingWorkerResults = Math.max(0, input.pendingWorkerResults ?? 0);
  const blockers: string[] = taskBlockers.map((blocker) =>
    blocker.message.trim() ? blocker.message.trim() : blocker.id,
  );

  const planning = determinePlanningStatus(latestArtifacts);
  let implementation = determineImplementationStatus(latestArtifacts);
  const review = determineLaneStatus(latestArtifacts.review);
  const verification = determineLaneStatus(latestArtifacts.verification);

  if (pendingWorkerResults > 0 && implementation !== "blocked") {
    implementation = "pending";
  }

  if (latestArtifacts.review?.state === "blocked") {
    const mergeDecision = readString(latestArtifacts.review.metadata?.mergeDecision);
    blockers.push(
      mergeDecision === "needs_changes"
        ? "Review merge decision requires changes."
        : "Review lane is blocked.",
    );
  } else if (review === "stale") {
    blockers.push("Review artifact is stale after later workspace mutations.");
  }

  if (latestArtifacts.verification?.state === "blocked") {
    const failedChecks = readStringArray(latestArtifacts.verification.metadata?.failedChecks);
    blockers.push(
      failedChecks.length > 0
        ? `Verification failed in ${formatPreviewList(failedChecks)}.`
        : "Verification lane is blocked.",
    );
  } else if (verification === "stale") {
    blockers.push("Verification artifact is stale after later workspace mutations.");
  }

  if (latestArtifacts.worker_patch?.state === "blocked") {
    blockers.push(compactText(latestArtifacts.worker_patch.summary, 200));
  } else if (latestArtifacts.worker_patch?.state === "pending" && pendingWorkerResults === 0) {
    blockers.push("Worker patch result is pending parent merge/apply.");
  }
  if (pendingWorkerResults > 0) {
    blockers.push(
      `Pending worker results require merge/apply (${pendingWorkerResults} result${pendingWorkerResults === 1 ? "" : "s"}).`,
    );
  }

  const dedupedBlockers = dedupeBlockers(blockers);
  const release: WorkflowReadiness["release"] =
    review === "missing" || verification === "missing"
      ? "missing"
      : dedupedBlockers.length > 0 || implementation === "blocked" || implementation === "pending"
        ? "blocked"
        : "ready";
  const latestObservedAt = Math.max(
    input.events.reduce((max, event) => Math.max(max, event.timestamp), 0),
    artifacts[0]?.producedAt ?? 0,
  );
  const updatedAt = latestObservedAt > 0 ? latestObservedAt : Date.now();

  const readiness: WorkflowReadiness = {
    sessionId: input.sessionId,
    planning,
    implementation,
    review,
    verification,
    release,
    blockers: dedupedBlockers,
    latestArtifactIds: uniqueStrings(
      [
        latestArtifacts.design?.artifactId,
        latestArtifacts.execution_plan?.artifactId,
        latestArtifacts.implementation?.artifactId,
        latestArtifacts.review?.artifactId,
        latestArtifacts.verification?.artifactId,
        latestArtifacts.worker_patch?.artifactId,
      ].filter((value): value is string => Boolean(value)),
    ),
    updatedAt,
  };

  const releaseArtifact = createReleaseArtifact({
    sessionId: input.sessionId,
    updatedAt,
    currentWorkspaceRevision,
    readiness,
    latestArtifacts,
  });
  const artifactsWithRelease = [releaseArtifact, ...artifacts].toSorted(
    (left, right) =>
      right.producedAt - left.producedAt ||
      (left.kind === "release_readiness"
        ? -1
        : right.kind === "release_readiness"
          ? 1
          : left.artifactId.localeCompare(right.artifactId)),
  );
  readiness.latestArtifactIds = uniqueStrings([
    ...readiness.latestArtifactIds,
    releaseArtifact.artifactId,
  ]);

  return {
    sessionId: input.sessionId,
    currentWorkspaceRevision,
    readiness,
    artifacts: artifactsWithRelease,
    pendingWorkerResults,
    updatedAt,
  };
}
