import type { CliTasksOverlayPayload } from "./overlays/payloads.js";

export type CliTaskRunRecord = CliTasksOverlayPayload["snapshot"]["taskRuns"][number];

export const TASKS_OVERLAY_HELP_LINE =
  "Use ↑/↓ to choose, Enter to open footer detail, c to cancel the selected run, Esc to close.";

export const TASKS_OVERLAY_FOOTER_TEXT = "Enter open footer detail · c cancel task · Esc close";

function renderDeliverySummary(delivery: CliTaskRunRecord["delivery"]): string {
  if (!delivery) {
    return "-";
  }

  const parts: string[] = [delivery.mode];
  if (delivery.handoffState) {
    parts.push(delivery.handoffState);
  }
  if (delivery.label) {
    parts.push(delivery.label);
  }
  return parts.join(" / ");
}

export function buildTaskRunListLabel(run: CliTaskRunRecord): string {
  return `${run.runId} ${run.status} :: ${run.label ?? run.summary ?? "-"}`;
}

export function buildTaskRunPreviewLines(run: CliTaskRunRecord): string[] {
  const firstArtifact = run.artifactRefs?.[0];
  return [
    `runId: ${run.runId}`,
    `delegate: ${run.delegate}`,
    `workerSessionId: ${run.workerSessionId ?? "-"}`,
    `label: ${run.label ?? "-"}`,
    `summary: ${run.summary ?? "-"}`,
    `error: ${run.error ?? "-"}`,
    `delivery: ${renderDeliverySummary(run.delivery)}`,
    firstArtifact ? `artifact: ${firstArtifact.path}` : "artifact: -",
  ];
}
