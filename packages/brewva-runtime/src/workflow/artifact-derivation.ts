import {
  isSemanticArtifactSchemaId,
  type BrewvaEventRecord,
  type SemanticArtifactSchemaId,
  type SkillNormalizedBlockingState,
  type SkillNormalizedOutputIssue,
  type SkillNormalizedOutputsView,
  type SkillSemanticBindings,
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
import { normalizeSkillOutputs } from "../skills/normalization.js";
import {
  collectExecutionVerificationIntents,
  collectPlanningOwnerLanes,
  collectPlanningRequiredEvidence,
  collectPlanningRiskCategories,
  coercePlanningArtifactSet,
  isPlanningArtifactSetComplete,
} from "../skills/planning-normalization.js";
import { coerceReviewReportArtifact } from "../skills/review-normalization.js";
import type { JsonValue } from "../utils/json.js";
import { collectQaCoverageTexts, collectVerificationCoverageTexts } from "./coverage-utils.js";
import {
  compactJsonValue,
  compactText,
  formatPreviewList,
  hasOwn,
  isRecord,
  readString,
  readStringArray,
  summarizeReviewReport,
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

const WORKFLOW_SEMANTIC_SCHEMA_BY_OUTPUT: Readonly<Record<string, SemanticArtifactSchemaId>> = {
  design_spec: "planning.design_spec.v2",
  execution_plan: "planning.execution_plan.v2",
  execution_mode_hint: "planning.execution_mode_hint.v2",
  risk_register: "planning.risk_register.v2",
  implementation_targets: "planning.implementation_targets.v2",
  change_set: "implementation.change_set.v2",
  files_changed: "implementation.files_changed.v2",
  verification_evidence: "implementation.verification_evidence.v2",
  review_report: "review.review_report.v2",
  review_findings: "review.review_findings.v2",
  merge_decision: "review.merge_decision.v2",
  qa_report: "qa.qa_report.v2",
  qa_findings: "qa.qa_findings.v2",
  qa_verdict: "qa.qa_verdict.v2",
  qa_checks: "qa.qa_checks.v2",
  qa_missing_evidence: "qa.qa_missing_evidence.v2",
  qa_confidence_gaps: "qa.qa_confidence_gaps.v2",
  qa_environment_limits: "qa.qa_environment_limits.v2",
  ship_report: "ship.ship_report.v2",
  release_checklist: "ship.release_checklist.v2",
  ship_decision: "ship.ship_decision.v2",
};

function readWorkflowSemanticBindings(
  payload: Record<string, unknown>,
): SkillSemanticBindings | undefined {
  const candidate = payload.semanticBindings;
  if (!isRecord(candidate)) {
    return undefined;
  }
  const entries = Object.entries(candidate).flatMap(([outputName, schemaId]) => {
    const normalizedOutputName = outputName.trim();
    if (!normalizedOutputName || typeof schemaId !== "string") {
      return [];
    }
    const normalizedSchemaId = schemaId.trim();
    if (!isSemanticArtifactSchemaId(normalizedSchemaId)) {
      return [];
    }
    return [[normalizedOutputName, normalizedSchemaId] as const];
  });
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function deriveWorkflowSemanticBindings(
  outputs: Record<string, unknown>,
  payload: Record<string, unknown>,
): SkillSemanticBindings | undefined {
  const explicitBindings = readWorkflowSemanticBindings(payload);
  const bindings: Record<string, SemanticArtifactSchemaId> = { ...explicitBindings };
  for (const key of Object.keys(outputs)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || hasOwn(bindings, normalizedKey)) {
      continue;
    }
    const schemaId = WORKFLOW_SEMANTIC_SCHEMA_BY_OUTPUT[normalizedKey];
    if (schemaId) {
      bindings[normalizedKey] = schemaId;
    }
  }
  return Object.keys(bindings).length > 0 ? bindings : undefined;
}

function buildBlockingStateForIssues(input: {
  issues: readonly SkillNormalizedOutputIssue[];
  rawPresent: boolean;
  normalizedPresent: boolean;
}): SkillNormalizedBlockingState {
  const blockingIssue = input.issues.find(
    (issue) => issue.tier === "tier_a" || issue.tier === "tier_b",
  );
  return {
    status: blockingIssue ? (blockingIssue.tier === "tier_a" ? "blocked" : "partial") : "ready",
    raw_present: input.rawPresent,
    normalized_present: input.normalizedPresent,
    partial: input.issues.length > 0,
    unresolved: uniqueStrings(input.issues.map((issue) => issue.path)),
    ...(blockingIssue?.blockingConsumer
      ? { blocking_consumer: blockingIssue.blockingConsumer }
      : {}),
  };
}

function sliceNormalizedOutputs(input: {
  normalized: SkillNormalizedOutputsView;
  rawOutputs: Record<string, unknown>;
  outputNames: readonly string[];
}): {
  canonical: Record<string, unknown>;
  issues: SkillNormalizedOutputIssue[];
  blockingState: SkillNormalizedBlockingState;
} {
  const keys = new Set(input.outputNames);
  const canonical = Object.fromEntries(
    Object.entries(input.normalized.canonical).filter(([key]) => keys.has(key)),
  );
  const issues = input.normalized.issues.filter((issue) => keys.has(issue.outputName));
  return {
    canonical,
    issues,
    blockingState: buildBlockingStateForIssues({
      issues,
      rawPresent: input.outputNames.some((key) => hasOwn(input.rawOutputs, key)),
      normalizedPresent: Object.keys(canonical).length > 0,
    }),
  };
}

function mapBlockingStateToArtifactState(
  blockingState: SkillNormalizedBlockingState,
): WorkflowArtifactState {
  if (blockingState.status === "blocked") {
    return "blocked";
  }
  if (blockingState.status === "partial") {
    return "pending";
  }
  return "ready";
}

function buildNormalizationMetadata(input: {
  blockingState: SkillNormalizedBlockingState;
  normalizerVersion: string;
  sourceEventId: string;
}): Record<string, JsonValue> {
  return {
    raw_present: input.blockingState.raw_present,
    normalized_present: input.blockingState.normalized_present,
    partial: input.blockingState.partial,
    unresolved: input.blockingState.unresolved,
    blockingConsumer: input.blockingState.blocking_consumer ?? null,
    normalizerVersion: input.normalizerVersion,
    sourceEventId: input.sourceEventId,
  };
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
  const normalizedWorkflowOutputs = normalizeSkillOutputs({
    outputs,
    semanticBindings: deriveWorkflowSemanticBindings(outputs, payload),
    sourceEventId: event.id,
  });
  const planningOutputs = sliceNormalizedOutputs({
    normalized: normalizedWorkflowOutputs,
    rawOutputs: outputs,
    outputNames: [
      "design_spec",
      "execution_plan",
      "execution_mode_hint",
      "risk_register",
      "implementation_targets",
    ],
  });
  const planningArtifacts = coercePlanningArtifactSet(planningOutputs.canonical);
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
        state: mapBlockingStateToArtifactState(planningOutputs.blockingState),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          raw_present: planningOutputs.blockingState.raw_present,
          normalized_present: planningOutputs.blockingState.normalized_present,
          partial: planningOutputs.blockingState.partial,
          unresolved: planningOutputs.blockingState.unresolved,
          blockingConsumer: planningOutputs.blockingState.blocking_consumer ?? null,
          normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
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
        state: mapBlockingStateToArtifactState(planningOutputs.blockingState),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          raw_present: hasOwn(outputs, "execution_plan"),
          normalized_present: Array.isArray(planningArtifacts.executionPlan),
          partial: planningOutputs.blockingState.partial,
          unresolved: planningOutputs.issues
            .filter((issue) => issue.outputName === "execution_plan")
            .map((issue) => issue.path),
          blockingConsumer:
            planningOutputs.issues.find((issue) => issue.outputName === "execution_plan")
              ?.blockingConsumer ?? null,
          normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
          stepCount: planSteps.length,
          verificationIntents: collectExecutionVerificationIntents(planningArtifacts.executionPlan),
          planComplete: isPlanningArtifactSetComplete(planningArtifacts),
        },
      }),
    );
  }

  const changeSet = outputs.change_set;
  const normalizedImplementation = sliceNormalizedOutputs({
    normalized: normalizedWorkflowOutputs,
    rawOutputs: outputs,
    outputNames: ["change_set", "files_changed"],
  });
  const filesChanged = readStringArray(normalizedImplementation.canonical.files_changed);
  const normalizedChangeSet = normalizedImplementation.canonical.change_set;
  if (changeSet !== undefined || hasOwn(outputs, "files_changed")) {
    const summary =
      filesChanged.length > 0
        ? `Implementation changed ${filesChanged.length} file(s): ${formatPreviewList(filesChanged)}.`
        : (compactJsonValue(normalizedChangeSet ?? changeSet) ??
          "Implementation artifact recorded.");
    drafts.push(
      createDraftArtifact({
        event,
        kind: "implementation",
        summary,
        sourceSkillNames: skillName ? [skillName] : [],
        outputKeys: ["change_set", "files_changed"].filter((key) => outputs[key] !== undefined),
        freshness: "fresh",
        state: mapBlockingStateToArtifactState(normalizedImplementation.blockingState),
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          filesChanged,
          ...buildNormalizationMetadata({
            blockingState: normalizedImplementation.blockingState,
            normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
            sourceEventId: event.id,
          }),
        },
        writeSide: true,
      }),
    );
  }

  const reviewOutputs = sliceNormalizedOutputs({
    normalized: normalizedWorkflowOutputs,
    rawOutputs: outputs,
    outputNames: ["review_report", "review_findings", "merge_decision"],
  });
  const reviewReport = reviewOutputs.canonical.review_report ?? outputs.review_report;
  const reviewFindings = reviewOutputs.canonical.review_findings ?? outputs.review_findings;
  const mergeDecision = readString(reviewOutputs.canonical.merge_decision);
  if (
    reviewReport !== undefined ||
    reviewFindings !== undefined ||
    mergeDecision ||
    hasOwn(outputs, "merge_decision")
  ) {
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
        state:
          reviewOutputs.blockingState.status === "blocked"
            ? "blocked"
            : reviewOutputs.blockingState.status === "partial"
              ? "pending"
              : mergeDecision && mergeDecision !== "ready"
                ? "blocked"
                : "ready",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          mergeDecision: mergeDecision ?? null,
          ...buildNormalizationMetadata({
            blockingState: reviewOutputs.blockingState,
            normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
            sourceEventId: event.id,
          }),
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

  const qaOutputs = sliceNormalizedOutputs({
    normalized: normalizedWorkflowOutputs,
    rawOutputs: outputs,
    outputNames: [
      "qa_report",
      "qa_findings",
      "qa_verdict",
      "qa_checks",
      "qa_missing_evidence",
      "qa_confidence_gaps",
      "qa_environment_limits",
    ],
  });
  const qaReport = qaOutputs.canonical.qa_report ?? outputs.qa_report;
  const qaFindings = qaOutputs.canonical.qa_findings ?? outputs.qa_findings;
  const qaVerdict = readString(qaOutputs.canonical.qa_verdict);
  const qaChecks = qaOutputs.canonical.qa_checks ?? outputs.qa_checks;
  const qaMissingEvidence = qaOutputs.canonical.qa_missing_evidence ?? outputs.qa_missing_evidence;
  const qaConfidenceGaps = qaOutputs.canonical.qa_confidence_gaps ?? outputs.qa_confidence_gaps;
  const qaEnvironmentLimits =
    qaOutputs.canonical.qa_environment_limits ?? outputs.qa_environment_limits;
  if (
    qaReport !== undefined ||
    qaFindings !== undefined ||
    qaVerdict ||
    hasOwn(outputs, "qa_verdict") ||
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
        state:
          qaOutputs.blockingState.status === "blocked"
            ? "blocked"
            : qaOutputs.blockingState.status === "partial"
              ? "pending"
              : qaVerdict === "pass"
                ? "ready"
                : qaVerdict === "fail"
                  ? "blocked"
                  : "pending",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          qaVerdict: qaVerdict ?? null,
          coverageTexts: collectQaCoverageTexts(qaOutputs.canonical),
          ...buildNormalizationMetadata({
            blockingState: qaOutputs.blockingState,
            normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
            sourceEventId: event.id,
          }),
        },
      }),
    );
  }

  const shipOutputs = sliceNormalizedOutputs({
    normalized: normalizedWorkflowOutputs,
    rawOutputs: outputs,
    outputNames: ["ship_report", "release_checklist", "ship_decision"],
  });
  const shipReport = shipOutputs.canonical.ship_report ?? outputs.ship_report;
  const releaseChecklist = shipOutputs.canonical.release_checklist ?? outputs.release_checklist;
  const shipDecision = readString(shipOutputs.canonical.ship_decision);
  if (
    shipReport !== undefined ||
    releaseChecklist !== undefined ||
    shipDecision ||
    hasOwn(outputs, "ship_decision")
  ) {
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
          shipOutputs.blockingState.status === "blocked"
            ? "blocked"
            : shipOutputs.blockingState.status === "partial"
              ? "pending"
              : shipDecision === "blocked"
                ? "blocked"
                : shipDecision === "needs_follow_up"
                  ? "pending"
                  : "ready",
        metadata: {
          source: "skill_completed",
          sourceSkillName: skillName ?? null,
          outputKeys,
          shipDecision: shipDecision ?? null,
          ...buildNormalizationMetadata({
            blockingState: shipOutputs.blockingState,
            normalizerVersion: normalizedWorkflowOutputs.normalizerVersion,
            sourceEventId: event.id,
          }),
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
  const missingChecks = readStringArray(payload.missingChecks);
  const rootCause = readString(payload.rootCause);
  const evidenceFreshness = readString(payload.evidenceFreshness);
  const summaryParts = [`Verification ${outcome}${level ? ` (${level})` : ""}.`];
  if (failedChecks.length > 0) {
    summaryParts.push(`Failed: ${formatPreviewList(failedChecks)}.`);
  } else if (missingChecks.length > 0) {
    summaryParts.push(`Missing fresh evidence: ${formatPreviewList(missingChecks)}.`);
  } else if (rootCause) {
    summaryParts.push(compactText(rootCause, 160));
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
        rootCause: rootCause ?? null,
        evidenceFreshness: evidenceFreshness ?? null,
        failedChecks,
        missingChecks,
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
        missingEvidence: readStringArray(resultData?.missing_evidence),
        confidenceGaps: readStringArray(resultData?.confidence_gaps),
        environmentLimits: readStringArray(resultData?.environment_limits),
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
