import { FITNESS_DISCREPANCY_GRADES } from "@brewva/brewva-vocabulary/fitness";
import {
  decideContinuationAnchorRelevance,
  TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
  type SessionCompactionAttentionRefs,
  type TaskWorkCardContextPressure,
  type TaskWorkCardProjection,
} from "@brewva/brewva-vocabulary/session";
import type { InspectReport } from "./report.js";

const ACTIVE_DELEGATION_LIFECYCLES = new Set(["pending", "running", "blocked"]);
const DEFAULT_MAX_WORK_CARD_LINES = 24;

type InspectReplayAnchor = NonNullable<InspectReport["replay"]["lastAnchor"]>;

function hasContinuationAnchorMetadata(
  anchor: InspectReport["replay"]["lastAnchor"],
): anchor is InspectReplayAnchor {
  return Boolean(anchor && decideContinuationAnchorRelevance(anchor).include);
}

export function buildTaskWorkCardProjection(report: InspectReport): TaskWorkCardProjection {
  const attention = report.contextCockpit.compaction.inputProvenance?.attention;
  const continuationAnchor = hasContinuationAnchorMetadata(report.replay.lastAnchor)
    ? report.replay.lastAnchor
    : null;
  const selectedCapabilities =
    report.contextCockpit.capabilities.latest?.selectedCapabilities ?? [];
  const skillInvocationRefs = report.contextCockpit.skills.invocationRecords.map(
    (record) => record.invocationId,
  );
  const resourceRefs = report.contextCockpit.skills.resourceRefs.map(
    (ref) => `${ref.kind}:${ref.path}`,
  );
  const recallResultRefs = report.contextCockpit.recall.results.map((result) => result.stableId);
  const compactBaselineRef = report.contextCockpit.compaction.latestBaseline?.compactId ?? null;
  const pendingWorkerPatches = report.delegation.workboard.pendingWorkerPatches;
  const latestPatchSetRef = pendingWorkerPatches[0]?.canonicalRefs[0] ?? null;

  return {
    schema: TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
    version: 2,
    sessionId: report.sessionId,
    refs: collectStableRefs([
      ...skillInvocationRefs,
      ...resourceRefs,
      ...recallResultRefs,
      ...report.operatorSafety.receiptIds,
      ...report.delegation.runCards.flatMap((card) => card.canonicalRefs),
      continuationAnchor?.id ?? null,
      compactBaselineRef,
    ]),
    goal: {
      current: report.task.goal,
      phase: report.task.phase,
      health: report.task.health,
      targetRoots: [report.analysis?.directory ?? report.workspaceRoot],
      taskItemCount: report.task.items,
      blockerCount: report.task.blockers,
    },
    persistentGoal: {
      objective: report.goalControl.objective,
      status: report.goalControl.status,
      tokenBudget: report.goalControl.tokenBudget,
      tokensUsed: report.goalControl.tokensUsed,
      elapsedMs: report.goalControl.elapsedMs,
      lastLifecycleEvent: report.goalControl.lastLifecycleEvent,
      latestContinuationRef: report.goalControl.latestContinuationRef,
      latestCompletionEvidenceRef: report.goalControl.latestCompletionEvidenceRef,
      latestBlockEvidenceRef: report.goalControl.latestBlockEvidenceRef,
    },
    context: {
      pressure: resolveContextPressure(report),
      workbenchEntryCount: report.contextCockpit.workbench.activeCount,
      skillInvocationRefs,
      resourceRefs,
      recallResultRefs,
      compactBaselineRef,
      automaticallyAvailableRefs: collectStableRefs([
        "current_request",
        "project_guidance",
        "target_roots",
        "capability_posture",
        "diff_posture",
        continuationAnchor?.id ?? null,
        "context_pressure",
      ]),
    },
    options: {
      generatedCount: attention?.generationIds.length ?? 0,
      consumedRefs: attentionRefs(attention, "consumedRefs"),
      pinnedRefs: attentionRefs(attention, "pinnedRefs"),
      ignoredRefs: attentionRefs(attention, "ignoredRefs"),
    },
    authority: {
      selectedCapabilities,
      capabilityReceiptRefs: report.contextCockpit.capabilities.receiptRefs,
      pendingAskCount: report.operatorSafety.pendingAsks,
      denialCount: report.operatorSafety.denials,
      recentDecisionRefs: report.operatorSafety.receiptIds,
    },
    work: {
      activeRunCount: report.delegation.runCards.filter((card) =>
        ACTIVE_DELEGATION_LIFECYCLES.has(card.lifecycle),
      ).length,
      pendingWorkerPatchCount: pendingWorkerPatches.length,
      pendingKnowledgeAdoptionCount: report.delegation.workboard.pendingKnowledgeAdoptions.length,
      unreadEvidenceCount: report.delegation.workboard.unreadEvidence.length,
      blockedOrFailedRunCount: report.delegation.workboard.blockedOrFailedRuns.length,
      recoveryNextOwner: report.delegation.recoveryPreview.nextReceiptOwner,
    },
    evidence: {
      verificationOutcome: report.verification.outcome,
      verificationLevel: report.verification.level,
      failedChecks: report.verification.failedChecks,
      missingChecks: report.verification.missingChecks,
      missingEvidence: report.verification.missingEvidence,
      verificationDebtCount: report.delegation.workboard.verificationDebt.length,
      latestPatchSetRef,
      verificationPerspective: report.verification.perspective,
      independenceBasis: report.verification.independenceBasis,
      // Tape-only judgment (`projectTapeReviewDebt`, shared with run-report
      // verification): already computed on `InspectReport.reviewDebt` from the
      // whole receipt history — read here, never re-derived.
      reviewDebt: report.reviewDebt.debt,
      // The SAME re-derived fitness `inspect run-report`'s Fitness section shows,
      // read straight off `InspectReport.requirementFitness` (folded once over the
      // whole tape via `summarizeRequirementFitness(buildTapeRequirementFitness)`).
      // Re-derived, not the latest receipt's frozen/empty annotation, so a clear
      // independent atoms-review's `satisfied` surfaces here too.
      fitness: report.requirementFitness,
    },
    continuationAnchor: {
      anchorId: continuationAnchor?.id ?? null,
      name: continuationAnchor?.name ?? null,
      summary: continuationAnchor?.summary ?? null,
      nextSteps: continuationAnchor?.nextSteps ?? null,
    },
  };
}

export interface WorkCardFormatOptions {
  readonly maxLines?: number;
}

export function formatTaskWorkCardText(
  projection: TaskWorkCardProjection,
  options: WorkCardFormatOptions = {},
): string {
  const maxLines = options.maxLines ?? DEFAULT_MAX_WORK_CARD_LINES;
  const lines = [
    `Work Card: schema=${projection.schema} session=${projection.sessionId}`,
    `Goal: ${projection.goal.current ?? "n/a"} phase=${projection.goal.phase ?? "n/a"} health=${projection.goal.health ?? "n/a"} refs=${renderList(projection.goal.targetRoots)}`,
    `Goal control: ${projection.persistentGoal?.objective ?? "n/a"} status=${projection.persistentGoal?.status ?? "none"} tokens=${projection.persistentGoal?.tokensUsed ?? 0}${projection.persistentGoal?.tokenBudget === null || projection.persistentGoal?.tokenBudget === undefined ? "" : `/${projection.persistentGoal.tokenBudget}`}`,
    `Context: pressure=${projection.context.pressure} workbench=${projection.context.workbenchEntryCount} skills=${projection.context.skillInvocationRefs.length} recall=${projection.context.recallResultRefs.length} baseline=${projection.context.compactBaselineRef ?? "none"}`,
    `Options: generated=${projection.options.generatedCount} consumed=${projection.options.consumedRefs.length} pinned=${projection.options.pinnedRefs.length} ignored=${projection.options.ignoredRefs.length}`,
    `Authority: capabilities=${renderList(projection.authority.selectedCapabilities)} pendingAsks=${projection.authority.pendingAskCount} denials=${projection.authority.denialCount} receipts=${renderList(projection.authority.capabilityReceiptRefs)}`,
    `Work: activeRuns=${projection.work.activeRunCount} workerPatches=${projection.work.pendingWorkerPatchCount} knowledge=${projection.work.pendingKnowledgeAdoptionCount} unreadEvidence=${projection.work.unreadEvidenceCount} blockedOrFailed=${projection.work.blockedOrFailedRunCount} nextReceiptOwner=${projection.work.recoveryNextOwner}`,
    `Evidence: outcome=${projection.evidence.verificationOutcome ?? "n/a"} level=${projection.evidence.verificationLevel ?? "n/a"} perspective=${projection.evidence.verificationPerspective} basis=${renderList(projection.evidence.independenceBasis)} failed=${renderList(projection.evidence.failedChecks)} missing=${renderList([...projection.evidence.missingChecks, ...projection.evidence.missingEvidence])} verificationDebt=${projection.evidence.verificationDebtCount} reviewDebt=${projection.evidence.reviewDebt} patch=${projection.evidence.latestPatchSetRef ?? "none"}`,
    formatFitnessLine(projection.evidence.fitness),
    `Continuation Anchor: anchor=${projection.continuationAnchor.anchorId ?? "none"} name=${projection.continuationAnchor.name ?? "n/a"} summary=${projection.continuationAnchor.summary ?? "n/a"} next=${projection.continuationAnchor.nextSteps ?? "n/a"}`,
    `Refs: ${renderList(projection.refs.slice(0, 8))}${projection.refs.length > 8 ? ` (+${projection.refs.length - 8} more)` : ""}`,
  ];

  return lines.slice(0, Math.max(1, maxLines)).join("\n");
}

/**
 * The Work Card's session-scale fitness line — `satisfied=`/`violated=`/
 * `unverifiedMust=`/by-grade counts from the SAME re-derived fitness `inspect
 * run-report`'s Fitness section shows (`InspectReport.requirementFitness`, folded
 * once over the whole tape). Deliberately narrower than run-report's line: it has
 * no `atoms=` total. The `satisfied` count closes the loop — an independent clear
 * atoms-review's affirmative half now shows, not just the negative violated/
 * unverified side. Honestly rendered even when every count is zero, so a reader is
 * never left wondering whether fitness was checked. Read-only pressure surface
 * (axiom 18): nothing here gates.
 */
function formatFitnessLine(fitness: TaskWorkCardProjection["evidence"]["fitness"]): string {
  const byGrade = FITNESS_DISCREPANCY_GRADES.map(
    (grade) => `${grade}=${fitness.discrepanciesByGrade[grade]}`,
  ).join(" ");
  return `fitness: satisfied=${fitness.satisfied} violated=${fitness.violated} unverifiedMust=${fitness.unverifiedMust} ${byGrade}`;
}

function resolveContextPressure(report: InspectReport): TaskWorkCardContextPressure {
  if (report.contextCockpit.context.gate.required === true) {
    return "forced";
  }
  const normalizedTapePressure = report.replay.tapePressure.toLowerCase();
  if (
    normalizedTapePressure === "low" ||
    normalizedTapePressure === "medium" ||
    normalizedTapePressure === "high"
  ) {
    return normalizedTapePressure;
  }
  const status = report.contextCockpit.context.gate.status;
  if (status.forcedCompaction) {
    return "forced";
  }
  if (status.compactionAdvised) {
    return "high";
  }
  return "unknown";
}

function attentionRefs(
  attention: SessionCompactionAttentionRefs | undefined,
  key: keyof Pick<SessionCompactionAttentionRefs, "consumedRefs" | "pinnedRefs" | "ignoredRefs">,
): readonly string[] {
  return attention?.[key] ?? [];
}

function collectStableRefs(values: readonly (string | null | undefined)[]): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      refs.add(trimmed);
    }
  }
  return [...refs];
}

function renderList(values: readonly string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}
