import type { WorkflowArtifact, WorkflowStatusSnapshot } from "../workflow/derivation.js";

const MAX_BLOCKERS = 3;
const MAX_ARTIFACT_SIGNALS = 4;

function trimNonEmpty(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function hasWorkflowSignal(snapshot: WorkflowStatusSnapshot): boolean {
  return (
    snapshot.pendingWorkerResults > 0 ||
    snapshot.artifacts.some((artifact) => artifact.kind !== "release_readiness")
  );
}

function formatArtifactSignal(artifact: WorkflowArtifact): string {
  return `${artifact.kind}[${artifact.state}/${artifact.freshness}]`;
}

function getLatestArtifactSignals(snapshot: WorkflowStatusSnapshot): string[] {
  const latestArtifactIds = new Set(snapshot.readiness.latestArtifactIds);
  return snapshot.artifacts
    .filter(
      (artifact) =>
        artifact.kind !== "release_readiness" && latestArtifactIds.has(artifact.artifactId),
    )
    .slice(0, MAX_ARTIFACT_SIGNALS)
    .map((artifact) => formatArtifactSignal(artifact));
}

export function buildWorkflowAdvisoryBlock(snapshot: WorkflowStatusSnapshot): string | undefined {
  if (!hasWorkflowSignal(snapshot)) {
    return undefined;
  }

  const lines = [
    "[WorkflowAdvisory]",
    "advisory_only: true",
    `planning: ${snapshot.readiness.planning}`,
    `implementation: ${snapshot.readiness.implementation}`,
    `review: ${snapshot.readiness.review}`,
    `verification: ${snapshot.readiness.verification}`,
    `release: ${snapshot.readiness.release}`,
  ];

  if (snapshot.pendingWorkerResults > 0) {
    lines.push(`pending_worker_results: ${snapshot.pendingWorkerResults}`);
  }

  const latestArtifactSignals = getLatestArtifactSignals(snapshot);
  if (latestArtifactSignals.length > 0) {
    lines.push(`latest_artifacts: ${latestArtifactSignals.join(", ")}`);
  }

  const blockers = trimNonEmpty(snapshot.readiness.blockers).slice(0, MAX_BLOCKERS);
  if (blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  lines.push("note: Advisory workflow state only; the model may choose another valid path.");
  return lines.join("\n");
}
