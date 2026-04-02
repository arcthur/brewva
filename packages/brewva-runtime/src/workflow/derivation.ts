import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  coercePlanningArtifactSet,
  collectExecutionVerificationIntents,
  collectPlanningOwnerLanes,
  collectPlanningRequiredEvidence,
  collectPlanningRiskCategories,
  coerceReviewReportArtifact,
  isPlanningArtifactSetComplete,
  type BrewvaEventRecord,
  type TaskState,
} from "../contracts/index.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
  WORKER_RESULTS_APPLY_FAILED_EVENT_TYPE,
} from "../events/event-types.js";
import { coerceGuardResultPayload, coerceMetricObservationPayload } from "../iteration/facts.js";
import type { JsonValue } from "../utils/json.js";
import {
  collectCoveredRequiredEvidence,
  collectQaCoverageTexts,
  collectVerificationCoverageTexts,
} from "./coverage-utils.js";

export const WORKFLOW_ARTIFACT_KINDS = [
  "discovery",
  "strategy_review",
  "learning_research",
  "design",
  "execution_plan",
  "implementation",
  "review",
  "qa",
  "verification",
  "ship",
  "retro",
  "worker_patch",
  "iteration_metric",
  "iteration_guard",
  "ship_posture",
] as const;

export type WorkflowArtifactKind = (typeof WORKFLOW_ARTIFACT_KINDS)[number];
export type WorkflowArtifactFreshness = "fresh" | "stale" | "unknown";
export type WorkflowArtifactState = "ready" | "blocked" | "pending";
export type WorkflowPresenceStatus = "missing" | "ready";
export type WorkflowLaneStatus = "missing" | "ready" | "stale" | "blocked" | "pending";
export type WorkflowPlanningStatus = "missing" | "ready";
export type WorkflowImplementationStatus = "missing" | "pending" | "ready" | "blocked";
export type WorkflowAcceptanceStatus = "not_required" | WorkflowLaneStatus;

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

export interface WorkflowPosture {
  sessionId: string;
  discovery: WorkflowPresenceStatus;
  strategy: WorkflowPresenceStatus;
  planning: WorkflowPlanningStatus;
  plan_complete: boolean;
  plan_fresh: boolean;
  implementation: WorkflowImplementationStatus;
  review_required: boolean;
  review: WorkflowLaneStatus;
  qa_required: boolean;
  qa: WorkflowLaneStatus;
  unsatisfied_required_evidence: string[];
  verification: WorkflowLaneStatus;
  acceptance: WorkflowAcceptanceStatus;
  ship: WorkflowLaneStatus;
  retro: WorkflowPresenceStatus;
  blockers: string[];
  latestArtifactIds: string[];
  updatedAt: number;
}

export interface WorkflowStatusSnapshot {
  sessionId: string;
  currentWorkspaceRevision?: string;
  posture: WorkflowPosture;
  artifacts: WorkflowArtifact[];
  pendingWorkerResults: number;
  pendingDelegationOutcomes: number;
  updatedAt: number;
}

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

interface TaskBlockerLike {
  id: string;
  message: string;
}

interface DeriveWorkflowStatusInput {
  sessionId: string;
  events: readonly BrewvaEventRecord[];
  blockers?: readonly TaskBlockerLike[];
  taskState?: Pick<TaskState, "spec" | "status" | "acceptance">;
  pendingWorkerResults?: number;
  pendingDelegationOutcomes?: number;
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

function summarizeReviewReport(value: unknown, maxChars = 220): string | undefined {
  const structured = coerceReviewReportArtifact(value);
  if (structured) {
    return compactText(structured.summary, maxChars);
  }
  return compactJsonValue(value, maxChars);
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
  const planningArtifacts = coercePlanningArtifactSet(outputs);
  const drafts: WorkflowDraftArtifact[] = [];
  const problemFrame = outputs.problem_frame;
  const userPains = outputs.user_pains;
  const scopeRecommendation = outputs.scope_recommendation;
  const designSeed = outputs.design_seed;
  const openQuestions = outputs.open_questions;
  if (
    problemFrame !== undefined ||
    userPains !== undefined ||
    scopeRecommendation !== undefined ||
    designSeed !== undefined ||
    openQuestions !== undefined
  ) {
    const painCount = readStringArray(userPains).length;
    const questionCount = readStringArray(openQuestions).length;
    const discoverySummaryParts = [
      compactJsonValue(problemFrame) ??
        compactJsonValue(scopeRecommendation) ??
        "Discovery artifact recorded.",
    ];
    if (painCount > 0) {
      discoverySummaryParts.push(`user_pains=${painCount}`);
    }
    if (questionCount > 0) {
      discoverySummaryParts.push(`open_questions=${questionCount}`);
    }
    drafts.push(
      createDraftArtifact({
        event,
        kind: "discovery",
        summary: discoverySummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: [
          "problem_frame",
          "user_pains",
          "scope_recommendation",
          "design_seed",
          "open_questions",
        ].filter((key) => outputs[key] !== undefined),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          userPainCount: painCount,
          openQuestionCount: questionCount,
        },
      }),
    );
  }

  const strategyReview = outputs.strategy_review;
  const scopeDecision = outputs.scope_decision;
  const strategicRisks = outputs.strategic_risks;
  const planningPosture = readString(outputs.planning_posture);
  if (
    strategyReview !== undefined ||
    scopeDecision !== undefined ||
    strategicRisks !== undefined ||
    planningPosture
  ) {
    const riskCount = readStringArray(strategicRisks).length;
    const strategySummaryParts = [
      compactJsonValue(strategyReview) ??
        compactJsonValue(scopeDecision) ??
        "Strategy review artifact recorded.",
    ];
    if (riskCount > 0) {
      strategySummaryParts.push(`strategic_risks=${riskCount}`);
    }
    if (planningPosture) {
      strategySummaryParts.push(`planning_posture=${planningPosture}`);
    }
    drafts.push(
      createDraftArtifact({
        event,
        kind: "strategy_review",
        summary: strategySummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: [
          "strategy_review",
          "scope_decision",
          "strategic_risks",
          "planning_posture",
        ].filter((key) => outputs[key] !== undefined),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          strategicRiskCount: riskCount,
          planningPosture: planningPosture ?? null,
        },
      }),
    );
  }

  const knowledgeBrief = outputs.knowledge_brief;
  const precedentRefs = readStringArray(outputs.precedent_refs);
  const preventiveChecks = readStringArray(outputs.preventive_checks);
  const precedentQuerySummary = readString(outputs.precedent_query_summary);
  const precedentConsultStatus = readString(outputs.precedent_consult_status);
  if (
    knowledgeBrief !== undefined ||
    precedentRefs.length > 0 ||
    preventiveChecks.length > 0 ||
    precedentQuerySummary ||
    precedentConsultStatus
  ) {
    const learningSummaryParts = [
      compactJsonValue(knowledgeBrief) ??
        (precedentConsultStatus === "no_relevant_precedent_found"
          ? "No relevant repository precedent matched the consult query."
          : "Learning research artifact recorded."),
    ];
    if (precedentConsultStatus) {
      learningSummaryParts.push(`consult_status=${precedentConsultStatus}`);
    }
    if (precedentRefs.length > 0) {
      learningSummaryParts.push(`precedent_refs=${precedentRefs.length}`);
    }
    if (preventiveChecks.length > 0) {
      learningSummaryParts.push(`preventive_checks=${preventiveChecks.length}`);
    }
    drafts.push(
      createDraftArtifact({
        event,
        kind: "learning_research",
        summary: learningSummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: [
          "knowledge_brief",
          "precedent_refs",
          "preventive_checks",
          "precedent_query_summary",
          "precedent_consult_status",
        ].filter((key) => outputs[key] !== undefined),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          precedentRefCount: precedentRefs.length,
          preventiveCheckCount: preventiveChecks.length,
          precedentConsultStatus: precedentConsultStatus ?? null,
          precedentQuerySummary: precedentQuerySummary ?? null,
          ...(precedentRefs.length > 0 ? { precedentRefs } : {}),
        },
      }),
    );
  }

  if (
    planningArtifacts.designSpec !== undefined ||
    planningArtifacts.executionModeHint !== undefined ||
    planningArtifacts.riskRegister !== undefined ||
    planningArtifacts.implementationTargets !== undefined
  ) {
    drafts.push(
      createDraftArtifact({
        event,
        kind: "design",
        summary: planningArtifacts.designSpec ?? "Design artifact recorded.",
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: [
          "design_spec",
          "execution_mode_hint",
          "risk_register",
          "implementation_targets",
        ].filter((key) => outputs[key] !== undefined),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          executionModeHint: planningArtifacts.executionModeHint ?? null,
          riskRegisterCount: planningArtifacts.riskRegister?.length ?? 0,
          implementationTargetCount: planningArtifacts.implementationTargets?.length ?? 0,
          requiredEvidence: collectPlanningRequiredEvidence(planningArtifacts.riskRegister),
          riskCategories: collectPlanningRiskCategories(planningArtifacts.riskRegister),
          ownerLanes: collectPlanningOwnerLanes(planningArtifacts.riskRegister),
          planComplete: isPlanningArtifactSetComplete(planningArtifacts),
        },
      }),
    );
  }

  if (outputs.execution_plan !== undefined) {
    const planSteps = planningArtifacts.executionPlan?.map((step) => step.step) ?? [];
    const summary =
      planSteps.length > 0
        ? `Execution plan with ${planSteps.length} step(s): ${formatPreviewList(planSteps)}.`
        : (compactJsonValue(outputs.execution_plan) ?? "Execution plan recorded.");
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
          verificationIntents: collectExecutionVerificationIntents(planningArtifacts.executionPlan),
          planComplete: isPlanningArtifactSetComplete(planningArtifacts),
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
    const structuredReviewReport = coerceReviewReportArtifact(reviewReport);
    const reviewSummaryParts = [];
    if (mergeDecision) {
      reviewSummaryParts.push(`decision=${mergeDecision}`);
    }
    const reviewText =
      summarizeReviewReport(reviewReport) ??
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
          ...(structuredReviewReport
            ? {
                activatedLanes: structuredReviewReport.activated_lanes,
                activationBasis: structuredReviewReport.activation_basis,
                missingEvidence: structuredReviewReport.missing_evidence,
                residualBlindSpots: structuredReviewReport.residual_blind_spots,
                precedentQuerySummary: structuredReviewReport.precedent_query_summary,
                precedentConsultStatus: {
                  status: structuredReviewReport.precedent_consult_status.status,
                  ...(structuredReviewReport.precedent_consult_status.precedent_refs
                    ? {
                        precedent_refs:
                          structuredReviewReport.precedent_consult_status.precedent_refs,
                      }
                    : {}),
                },
                ...(structuredReviewReport.lane_disagreements
                  ? {
                      laneDisagreements: structuredReviewReport.lane_disagreements,
                    }
                  : {}),
              }
            : {}),
        },
      }),
    );
  }

  const qaReport = outputs.qa_report;
  const qaFindings = outputs.qa_findings;
  const qaVerdict = readString(outputs.qa_verdict);
  const qaChecks = outputs.qa_checks;
  const qaMissingEvidence = outputs.qa_missing_evidence;
  const qaConfidenceGaps = outputs.qa_confidence_gaps;
  const qaEnvironmentLimits = outputs.qa_environment_limits;
  if (
    qaReport !== undefined ||
    qaFindings !== undefined ||
    qaVerdict ||
    qaChecks !== undefined ||
    qaMissingEvidence !== undefined ||
    qaConfidenceGaps !== undefined ||
    qaEnvironmentLimits !== undefined
  ) {
    const qaSummaryParts = [];
    if (qaVerdict) {
      qaSummaryParts.push(`verdict=${qaVerdict}`);
    }
    const qaText =
      compactJsonValue(qaReport) ??
      compactJsonValue(qaFindings) ??
      compactJsonValue(qaChecks) ??
      compactJsonValue(qaMissingEvidence) ??
      "QA artifact recorded.";
    qaSummaryParts.push(qaText);
    drafts.push(
      createDraftArtifact({
        event,
        kind: "qa",
        summary: qaSummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: [
          "qa_report",
          "qa_findings",
          "qa_verdict",
          "qa_checks",
          "qa_missing_evidence",
          "qa_confidence_gaps",
          "qa_environment_limits",
        ].filter((key) => outputs[key] !== undefined),
        freshness: "fresh",
        state: qaVerdict === "pass" ? "ready" : qaVerdict === "fail" ? "blocked" : "pending",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          qaVerdict: qaVerdict ?? null,
          coverageTexts: collectQaCoverageTexts(outputs),
        },
      }),
    );
  }

  const shipReport = outputs.ship_report;
  const releaseChecklist = outputs.release_checklist;
  const shipDecision = readString(outputs.ship_decision);
  if (shipReport !== undefined || releaseChecklist !== undefined || shipDecision) {
    const shipSummaryParts = [];
    if (shipDecision) {
      shipSummaryParts.push(`decision=${shipDecision}`);
    }
    const shipText =
      compactJsonValue(shipReport) ??
      compactJsonValue(releaseChecklist) ??
      "Ship artifact recorded.";
    shipSummaryParts.push(shipText);
    drafts.push(
      createDraftArtifact({
        event,
        kind: "ship",
        summary: shipSummaryParts.join("; "),
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["ship_report", "release_checklist", "ship_decision"].filter(
          (key) => outputs[key] !== undefined,
        ),
        freshness: "fresh",
        state:
          shipDecision === "blocked"
            ? "blocked"
            : shipDecision === "needs_follow_up"
              ? "pending"
              : "ready",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          shipDecision: shipDecision ?? null,
        },
      }),
    );
  }

  const retroSummary = outputs.retro_summary;
  const retroFindings = outputs.retro_findings;
  const followupRecommendation = outputs.followup_recommendation;
  if (
    retroSummary !== undefined ||
    retroFindings !== undefined ||
    followupRecommendation !== undefined
  ) {
    drafts.push(
      createDraftArtifact({
        event,
        kind: "retro",
        summary:
          compactJsonValue(retroSummary) ??
          compactJsonValue(followupRecommendation) ??
          compactJsonValue(retroFindings) ??
          "Retro artifact recorded.",
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["retro_summary", "retro_findings", "followup_recommendation"].filter(
          (key) => outputs[key] !== undefined,
        ),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
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
        coverageTexts: collectVerificationCoverageTexts(payload),
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

  const delegate = readString(payload.delegate);
  const skillName = readString(payload.skillName);
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
        delegate: delegate ?? null,
        runId: readString(payload.runId) ?? null,
      },
    }),
  ];
}

function extractSubagentQaArtifact(event: BrewvaEventRecord): WorkflowDraftArtifact[] {
  const payload = event.payload;
  if (!isRecord(payload)) return [];
  if (readString(payload.kind) !== "qa") return [];

  const delegate = readString(payload.delegate);
  const skillName = readString(payload.skillName);
  const resultData = isRecord(payload.resultData) ? payload.resultData : undefined;
  const verdict = readString(resultData?.verdict);
  const summary =
    compactJsonValue(payload.summary, 200) ??
    compactJsonValue(resultData?.checks, 200) ??
    (event.type === SUBAGENT_COMPLETED_EVENT_TYPE
      ? "Delegated QA completed."
      : "Delegated QA failed.");

  return [
    createDraftArtifact({
      event,
      kind: "qa",
      summary,
      sourceSkillNames: skillName ? [skillName] : [],
      outputKeys: [
        "qa_report",
        "qa_findings",
        "qa_verdict",
        "qa_checks",
        "qa_missing_evidence",
        "qa_confidence_gaps",
        "qa_environment_limits",
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
        delegate: delegate ?? null,
        runId: readString(payload.runId) ?? null,
        qaVerdict: verdict ?? null,
        missingEvidence: readStringArray(resultData?.missingEvidence),
        confidenceGaps: readStringArray(resultData?.confidenceGaps),
        environmentLimits: readStringArray(resultData?.environmentLimits),
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
    if (event.type === "skill_completed") return extractSkillCompletedArtifacts(event);
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
      return [...extractSubagentPatchArtifact(event), ...extractSubagentQaArtifact(event)];
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
      artifact.kind === "qa" ||
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
          artifact.kind === "qa" ||
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

function determinePlanComplete(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
): boolean {
  return latestArtifacts.design?.metadata?.planComplete === true;
}

function determinePlanFresh(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
): boolean {
  const candidates = [latestArtifacts.design, latestArtifacts.execution_plan].filter(
    (artifact): artifact is WorkflowArtifact => Boolean(artifact),
  );
  if (candidates.length === 0) {
    return false;
  }
  return candidates.every((artifact) => artifact.freshness !== "stale");
}

function determinePresenceStatus(artifact: WorkflowArtifact | undefined): WorkflowPresenceStatus {
  return artifact ? "ready" : "missing";
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
  if (artifact.state === "pending") return "pending";
  if (artifact.freshness === "stale") return "stale";
  return "ready";
}

function determineAcceptanceStatus(
  taskState: DeriveWorkflowStatusInput["taskState"],
): WorkflowAcceptanceStatus {
  if (taskState?.spec?.acceptance?.required !== true) {
    return "not_required";
  }
  if (taskState.acceptance?.status === "accepted") {
    return "ready";
  }
  if (
    taskState.acceptance?.status === "rejected" ||
    taskState.status?.health === "acceptance_rejected"
  ) {
    return "blocked";
  }
  if (
    taskState.acceptance?.status === "pending" ||
    taskState.status?.phase === "ready_for_acceptance" ||
    taskState.status?.health === "acceptance_pending"
  ) {
    return "pending";
  }
  return "missing";
}

function determineReviewRequired(input: {
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>;
  planComplete: boolean;
  implementation: WorkflowImplementationStatus;
}): boolean {
  const planningPosture = readString(
    input.latestArtifacts.strategy_review?.metadata?.planningPosture,
  );
  const ownerLanes = readStringArray(input.latestArtifacts.design?.metadata?.ownerLanes);
  return Boolean(
    planningPosture === "high_risk" ||
    planningPosture === "complex" ||
    !input.planComplete ||
    input.implementation !== "missing" ||
    ownerLanes.some((lane) => lane.startsWith("review-")) ||
    input.latestArtifacts.review,
  );
}

function determineQaRequired(input: {
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>;
  implementation: WorkflowImplementationStatus;
}): boolean {
  const planningPosture = readString(
    input.latestArtifacts.strategy_review?.metadata?.planningPosture,
  );
  const ownerLanes = readStringArray(input.latestArtifacts.design?.metadata?.ownerLanes);
  const requiredEvidence = readStringArray(
    input.latestArtifacts.design?.metadata?.requiredEvidence,
  );
  return Boolean(
    planningPosture === "high_risk" ||
    ownerLanes.includes("qa") ||
    requiredEvidence.length > 0 ||
    input.implementation !== "missing" ||
    input.latestArtifacts.qa,
  );
}

function resolveLatestFreshVerificationCoverageTexts(
  artifacts: readonly WorkflowArtifact[],
): string[] {
  const verificationArtifacts = artifacts
    .filter((artifact) => artifact.kind === "verification")
    .toSorted((left, right) => right.producedAt - left.producedAt);
  for (const artifact of verificationArtifacts) {
    if (artifact.freshness !== "fresh") {
      continue;
    }
    const coverageTexts = readStringArray(artifact.metadata?.coverageTexts);
    if (coverageTexts.length > 0) {
      return coverageTexts;
    }
  }
  return [];
}

function determineUnsatisfiedRequiredEvidence(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
  artifacts: readonly WorkflowArtifact[],
): string[] {
  const requiredEvidence = readStringArray(latestArtifacts.design?.metadata?.requiredEvidence);
  if (requiredEvidence.length === 0) {
    return [];
  }
  const qaCoverageTexts = readStringArray(latestArtifacts.qa?.metadata?.coverageTexts);
  const verificationCoverageTexts = resolveLatestFreshVerificationCoverageTexts(artifacts);
  const coveredRequiredEvidence = collectCoveredRequiredEvidence(
    requiredEvidence,
    uniqueStrings([...qaCoverageTexts, ...verificationCoverageTexts]),
  );
  return requiredEvidence.filter((evidenceName) => !coveredRequiredEvidence.includes(evidenceName));
}

function determineShipStatus(input: {
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>;
  implementation: WorkflowImplementationStatus;
  review: WorkflowLaneStatus;
  qa: WorkflowLaneStatus;
  verification: WorkflowLaneStatus;
  acceptance: WorkflowAcceptanceStatus;
  hasBlockers: boolean;
}): WorkflowLaneStatus {
  const shipArtifact = input.latestArtifacts.ship;
  const prerequisitesMissing = input.review === "missing" || input.verification === "missing";
  const prerequisitesBlocked =
    input.implementation === "blocked" ||
    input.implementation === "pending" ||
    input.review === "blocked" ||
    input.review === "stale" ||
    input.qa === "blocked" ||
    input.qa === "pending" ||
    input.qa === "stale" ||
    input.verification === "blocked" ||
    input.verification === "stale" ||
    (input.acceptance !== "not_required" && input.acceptance !== "ready") ||
    input.hasBlockers;

  if (!shipArtifact) {
    if (prerequisitesMissing) return "missing";
    if (prerequisitesBlocked) return "blocked";
    return "ready";
  }

  if (shipArtifact.state === "blocked") return "blocked";
  if (shipArtifact.state === "pending") return "pending";
  if (shipArtifact.freshness === "stale") return "stale";
  if (prerequisitesMissing) return "missing";
  if (prerequisitesBlocked) return "blocked";
  return "ready";
}

function determineRetroStatus(
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>,
): WorkflowPresenceStatus {
  const retro = latestArtifacts.retro;
  if (!retro) return "missing";
  const ship = latestArtifacts.ship;
  if (ship && retro.producedAt < ship.producedAt) {
    return "missing";
  }
  return "ready";
}

function dedupeBlockers(blockers: readonly string[]): string[] {
  return [...new Set(blockers.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function createShipPostureArtifact(input: {
  sessionId: string;
  updatedAt: number;
  currentWorkspaceRevision?: string;
  posture: WorkflowPosture;
  latestArtifacts: Partial<Record<WorkflowArtifactKind, WorkflowArtifact>>;
}): WorkflowArtifact {
  const latestCoreArtifacts = [
    input.latestArtifacts.discovery,
    input.latestArtifacts.strategy_review,
    input.latestArtifacts.learning_research,
    input.latestArtifacts.design,
    input.latestArtifacts.execution_plan,
    input.latestArtifacts.implementation,
    input.latestArtifacts.review,
    input.latestArtifacts.qa,
    input.latestArtifacts.verification,
    input.latestArtifacts.ship,
    input.latestArtifacts.retro,
    input.latestArtifacts.worker_patch,
  ].filter((artifact): artifact is WorkflowArtifact => Boolean(artifact));

  const sourceEventIds = uniqueStrings(
    latestCoreArtifacts.flatMap((artifact) => artifact.sourceEventIds),
  );
  const sourceSkillNames = uniqueStrings(
    latestCoreArtifacts.flatMap((artifact) => artifact.sourceSkillNames),
  );

  const blockerPreview =
    input.posture.blockers.length > 0
      ? ` Blockers: ${formatPreviewList(input.posture.blockers, 2)}.`
      : "";
  const summary = `Ship posture is ${input.posture.ship}.${blockerPreview}`;

  return {
    artifactId: `wfart:ship_posture:${input.sessionId}:${input.updatedAt}`,
    sessionId: input.sessionId,
    kind: "ship_posture",
    summary,
    sourceEventIds,
    sourceSkillNames,
    outputKeys: [],
    producedAt: input.updatedAt,
    freshness:
      input.posture.ship === "ready"
        ? "fresh"
        : input.posture.ship === "stale" ||
            input.posture.review === "stale" ||
            input.posture.qa === "stale" ||
            input.posture.verification === "stale"
          ? "stale"
          : "unknown",
    state:
      input.posture.ship === "ready"
        ? "ready"
        : input.posture.ship === "blocked"
          ? "blocked"
          : "pending",
    workspaceRevision: input.currentWorkspaceRevision,
    metadata: {
      source: "workflow_status",
      ship: input.posture.ship,
      acceptance: input.posture.acceptance,
      blockers: input.posture.blockers,
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
  const pendingDelegationOutcomes = Math.max(0, input.pendingDelegationOutcomes ?? 0);
  const blockers: string[] = taskBlockers.map((blocker) =>
    blocker.message.trim() ? blocker.message.trim() : blocker.id,
  );

  const planning = determinePlanningStatus(latestArtifacts);
  const planComplete = determinePlanComplete(latestArtifacts);
  const planFresh = determinePlanFresh(latestArtifacts);
  const discovery = determinePresenceStatus(latestArtifacts.discovery);
  const strategy = determinePresenceStatus(latestArtifacts.strategy_review);
  let implementation = determineImplementationStatus(latestArtifacts);
  const review = determineLaneStatus(latestArtifacts.review);
  const qa = determineLaneStatus(latestArtifacts.qa);
  const verification = determineLaneStatus(latestArtifacts.verification);
  const acceptance = determineAcceptanceStatus(input.taskState);

  if (pendingWorkerResults > 0 && implementation !== "blocked") {
    implementation = "pending";
  }
  const reviewRequired = determineReviewRequired({
    latestArtifacts,
    planComplete,
    implementation,
  });
  const qaRequired = determineQaRequired({
    latestArtifacts,
    implementation,
  });
  const unsatisfiedRequiredEvidence = determineUnsatisfiedRequiredEvidence(
    latestArtifacts,
    artifacts,
  );

  if (planning === "ready" && !planComplete) {
    blockers.push(
      "Planning artifacts are present but incomplete for the canonical design contract.",
    );
  }
  if (planning === "ready" && !planFresh) {
    blockers.push("Planning artifacts are stale relative to the latest workspace state.");
  }
  if (reviewRequired && review === "missing") {
    blockers.push("Review is required for the current scope and has not been completed.");
  }
  if (qaRequired && qa === "missing") {
    blockers.push("QA is required for the current scope and has not been completed.");
  }
  if (unsatisfiedRequiredEvidence.length > 0) {
    blockers.push(
      `Plan-declared required evidence remains unsatisfied: ${formatPreviewList(unsatisfiedRequiredEvidence)}.`,
    );
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

  if (latestArtifacts.qa?.state === "blocked") {
    const qaVerdict = readString(latestArtifacts.qa.metadata?.qaVerdict);
    blockers.push(
      qaVerdict === "fail" ? "QA reported failing checks before shipping." : "QA lane is blocked.",
    );
  } else if (latestArtifacts.qa?.state === "pending") {
    blockers.push("QA remains inconclusive and needs more executable evidence.");
  } else if (qa === "stale") {
    blockers.push("QA artifact is stale after later workspace mutations.");
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
  if (pendingDelegationOutcomes > 0) {
    blockers.push(
      `Pending delegation outcomes require parent attention (${pendingDelegationOutcomes} outcome${pendingDelegationOutcomes === 1 ? "" : "s"}).`,
    );
  }

  const dedupedBlockers = dedupeBlockers(blockers);
  const ship = determineShipStatus({
    latestArtifacts,
    implementation,
    review,
    qa,
    verification,
    acceptance,
    hasBlockers: dedupedBlockers.length > 0,
  });
  const retro = determineRetroStatus(latestArtifacts);

  if (acceptance === "pending") {
    blockers.push("Acceptance required before closure.");
  } else if (acceptance === "blocked") {
    const notes = readString(input.taskState?.acceptance?.notes);
    blockers.push(
      notes
        ? `Acceptance rejected; revise before closure (${compactText(notes, 120)}).`
        : "Acceptance rejected; revise before closure.",
    );
  }

  if (latestArtifacts.ship?.state === "blocked") {
    blockers.push(compactText(latestArtifacts.ship.summary, 200));
  } else if (latestArtifacts.ship?.state === "pending") {
    blockers.push(compactText(latestArtifacts.ship.summary, 200));
  } else if (ship === "stale") {
    blockers.push("Ship artifact is stale after later workflow evidence changed.");
  }

  const finalBlockers = dedupeBlockers(blockers);
  const latestObservedAt = Math.max(
    input.events.reduce((max, event) => Math.max(max, event.timestamp), 0),
    artifacts[0]?.producedAt ?? 0,
  );
  const updatedAt = latestObservedAt > 0 ? latestObservedAt : Date.now();

  const posture: WorkflowPosture = {
    sessionId: input.sessionId,
    discovery,
    strategy,
    planning,
    plan_complete: planComplete,
    plan_fresh: planFresh,
    implementation,
    review_required: reviewRequired,
    review,
    qa_required: qaRequired,
    qa,
    unsatisfied_required_evidence: unsatisfiedRequiredEvidence,
    verification,
    acceptance,
    ship,
    retro,
    blockers: finalBlockers,
    latestArtifactIds: uniqueStrings(
      [
        latestArtifacts.discovery?.artifactId,
        latestArtifacts.strategy_review?.artifactId,
        latestArtifacts.learning_research?.artifactId,
        latestArtifacts.design?.artifactId,
        latestArtifacts.execution_plan?.artifactId,
        latestArtifacts.implementation?.artifactId,
        latestArtifacts.review?.artifactId,
        latestArtifacts.qa?.artifactId,
        latestArtifacts.verification?.artifactId,
        latestArtifacts.ship?.artifactId,
        latestArtifacts.retro?.artifactId,
        latestArtifacts.worker_patch?.artifactId,
      ].filter((value): value is string => Boolean(value)),
    ),
    updatedAt,
  };

  const shipPostureArtifact = createShipPostureArtifact({
    sessionId: input.sessionId,
    updatedAt,
    currentWorkspaceRevision,
    posture,
    latestArtifacts,
  });
  const artifactsWithShipPosture = [shipPostureArtifact, ...artifacts].toSorted(
    (left, right) =>
      right.producedAt - left.producedAt ||
      (left.kind === "ship_posture"
        ? -1
        : right.kind === "ship_posture"
          ? 1
          : left.artifactId.localeCompare(right.artifactId)),
  );
  posture.latestArtifactIds = uniqueStrings([
    ...posture.latestArtifactIds,
    shipPostureArtifact.artifactId,
  ]);

  return {
    sessionId: input.sessionId,
    currentWorkspaceRevision,
    posture,
    artifacts: artifactsWithShipPosture,
    pendingWorkerResults,
    pendingDelegationOutcomes,
    updatedAt,
  };
}
