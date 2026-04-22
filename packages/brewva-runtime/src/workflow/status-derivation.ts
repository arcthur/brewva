import type { TaskState } from "../contracts/index.js";
import type { SkillReadinessEntry } from "../contracts/skill-readiness.js";
import { deriveWorkflowArtifacts, latestArtifactByKind } from "./artifact-derivation.js";
import { collectCoveredRequiredEvidence } from "./coverage-utils.js";
import {
  buildNormalizationBlockerMessage,
  compactText,
  formatPreviewList,
  readString,
  readStringArray,
  uniqueStrings,
} from "./shared.js";
import type {
  WorkflowAcceptanceStatus,
  WorkflowArtifact,
  WorkflowArtifactKind,
  WorkflowFinishView,
  WorkflowImplementationStatus,
  WorkflowLaneStatus,
  WorkflowPlanningStatus,
  WorkflowPosture,
  WorkflowPresenceStatus,
  WorkflowStatusSnapshot,
} from "./types.js";
import { resolveWorkspaceRevision } from "./workspace-revision.js";

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
  taskState: Pick<TaskState, "spec" | "status" | "acceptance"> | undefined,
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

function deriveFinishView(input: {
  posture: WorkflowPosture;
  artifacts: readonly WorkflowArtifact[];
  explicitBlockerPresent: boolean;
}): WorkflowFinishView {
  const posture = input.posture;
  const reviewSatisfied = !posture.review_required || posture.review === "ready";
  const qaSatisfied = !posture.qa_required || posture.qa === "ready";
  const completed =
    posture.implementation === "ready" &&
    reviewSatisfied &&
    qaSatisfied &&
    posture.unsatisfied_required_evidence.length === 0;
  const verified = posture.verification === "ready";
  const acceptanceReady = posture.acceptance === "not_required" || posture.acceptance === "ready";
  const deliverable =
    completed &&
    verified &&
    acceptanceReady &&
    posture.ship === "ready" &&
    posture.blockers.length === 0;
  const missingEvidence = uniqueStrings([
    ...posture.unsatisfied_required_evidence,
    ...(posture.review_required && posture.review !== "ready" ? [`review:${posture.review}`] : []),
    ...(posture.qa_required && posture.qa !== "ready" ? [`qa:${posture.qa}`] : []),
    ...(completed && posture.verification !== "ready"
      ? [`verification:${posture.verification}`]
      : []),
  ]);
  const nonAcceptanceBlockers = posture.blockers.filter(
    (blocker) => !blocker.startsWith("Acceptance required before closure."),
  );
  const operationalBlockerPresent = posture.blockers.some(
    (blocker) =>
      blocker.startsWith("Pending worker results") ||
      blocker.startsWith("Pending delegation outcomes") ||
      blocker.startsWith("Worker patch result") ||
      blocker.startsWith("Acceptance rejected"),
  );
  const started =
    input.artifacts.some((artifact) => artifact.kind !== "ship_posture") ||
    posture.discovery === "ready" ||
    posture.strategy === "ready" ||
    posture.planning === "ready" ||
    posture.implementation !== "missing" ||
    posture.review !== "missing" ||
    posture.qa !== "missing" ||
    posture.verification !== "missing" ||
    posture.ship !== "missing" ||
    posture.retro === "ready" ||
    input.explicitBlockerPresent ||
    operationalBlockerPresent;

  if (!started) {
    return {
      state: "not_started",
      completed,
      verified,
      acceptance: posture.acceptance,
      ship: posture.ship,
      deliverable,
      missingEvidence,
      blockers: posture.blockers,
      summary: "Not started: no workflow artifacts are present yet.",
    };
  }

  if (deliverable) {
    return {
      state: "deliverable",
      completed,
      verified,
      acceptance: posture.acceptance,
      ship: posture.ship,
      deliverable,
      missingEvidence,
      blockers: posture.blockers,
      summary: "Deliverable: implementation, verification, acceptance, and ship posture are ready.",
    };
  }

  if (
    completed &&
    verified &&
    posture.acceptance === "pending" &&
    nonAcceptanceBlockers.length === 0
  ) {
    return {
      state: "ready_for_acceptance",
      completed,
      verified,
      acceptance: posture.acceptance,
      ship: posture.ship,
      deliverable,
      missingEvidence,
      blockers: posture.blockers,
      summary:
        "Ready for acceptance: technical closure is ready and operator acceptance remains pending.",
    };
  }

  if (posture.blockers.length > 0 || missingEvidence.length > 0 || posture.ship === "blocked") {
    const preview =
      posture.blockers[0] ?? `Missing evidence: ${formatPreviewList(missingEvidence)}.`;
    return {
      state: "blocked",
      completed,
      verified,
      acceptance: posture.acceptance,
      ship: posture.ship,
      deliverable,
      missingEvidence,
      blockers: posture.blockers,
      summary: compactText(preview, 200),
    };
  }

  return {
    state: "in_progress",
    completed,
    verified,
    acceptance: posture.acceptance,
    ship: posture.ship,
    deliverable,
    missingEvidence,
    blockers: posture.blockers,
    summary: "In progress: workflow closure evidence is still forming.",
  };
}

export function deriveWorkflowStatus(input: {
  sessionId: string;
  events: readonly import("../contracts/index.js").BrewvaEventRecord[];
  blockers?: readonly { id: string; message: string }[];
  taskState?: Pick<TaskState, "spec" | "status" | "acceptance">;
  pendingWorkerResults?: number;
  pendingDelegationOutcomes?: number;
  skillReadiness: readonly SkillReadinessEntry[];
  workspaceRoot?: string;
}): WorkflowStatusSnapshot {
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

  const implementationNormalizationBlocker = buildNormalizationBlockerMessage(
    "Implementation artifact",
    latestArtifacts.implementation,
  );
  if (implementationNormalizationBlocker) {
    blockers.push(implementationNormalizationBlocker);
  }

  const reviewNormalizationBlocker = buildNormalizationBlockerMessage(
    "Review artifact",
    latestArtifacts.review,
  );
  if (reviewNormalizationBlocker) {
    blockers.push(reviewNormalizationBlocker);
  } else if (latestArtifacts.review?.state === "blocked") {
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
    const missingChecks = readStringArray(latestArtifacts.verification.metadata?.missingChecks);
    const rootCause = readString(latestArtifacts.verification.metadata?.rootCause);
    blockers.push(
      failedChecks.length > 0 && missingChecks.length > 0
        ? `Verification failed in ${formatPreviewList(failedChecks)} and is missing fresh evidence for ${formatPreviewList(missingChecks)}.`
        : failedChecks.length > 0
          ? `Verification failed in ${formatPreviewList(failedChecks)}.`
          : missingChecks.length > 0
            ? `Verification missing fresh evidence for ${formatPreviewList(missingChecks)}.`
            : rootCause
              ? compactText(rootCause, 200)
              : "Verification artifact is blocked without canonical failed/missing check classification.",
    );
  } else if (verification === "stale") {
    blockers.push("Verification artifact is stale after later workspace mutations.");
  }

  const qaNormalizationBlocker = buildNormalizationBlockerMessage(
    "QA artifact",
    latestArtifacts.qa,
  );
  if (qaNormalizationBlocker) {
    blockers.push(qaNormalizationBlocker);
  } else if (latestArtifacts.qa?.state === "blocked") {
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

  const shipNormalizationBlocker = buildNormalizationBlockerMessage(
    "Ship artifact",
    latestArtifacts.ship,
  );
  if (shipNormalizationBlocker) {
    blockers.push(shipNormalizationBlocker);
  } else if (latestArtifacts.ship?.state === "blocked") {
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
  const finish = deriveFinishView({
    posture,
    artifacts,
    explicitBlockerPresent: taskBlockers.length > 0,
  });

  return {
    sessionId: input.sessionId,
    currentWorkspaceRevision,
    posture,
    finish,
    skillReadiness: [...input.skillReadiness],
    artifacts: artifactsWithShipPosture,
    pendingWorkerResults,
    pendingDelegationOutcomes,
    updatedAt,
  };
}
