import { isRecord } from "@brewva/brewva-std/unknown";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import { questionRequestsFromSnapshot } from "../domain/question-utils.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function hasDiffPreviewPayload(value: unknown): boolean {
  const record = asRecord(value);
  const preview = asRecord(record?.diffPreview ?? record?.previewDiff ?? record?.preview);
  if (!preview) {
    return false;
  }
  if (typeof preview.diff === "string" || typeof preview.error === "string") {
    return true;
  }
  const files = preview.files;
  return Array.isArray(files) && files.length > 0;
}

export function selectableItemCount(payload: CliShellOverlayPayload): number | undefined {
  if (payload.kind === "approval") {
    return payload.snapshot.approvals.length;
  }
  if (payload.kind === "question") {
    return questionRequestsFromSnapshot(payload.snapshot).length;
  }
  if (payload.kind === "tasks") {
    return payload.snapshot.taskRuns.length;
  }
  if (payload.kind === "sessions") {
    return payload.sessions.length;
  }
  if (payload.kind === "lineage") {
    return payload.nodes.length;
  }
  if (payload.kind === "tree") {
    return payload.nodes.length;
  }
  if (payload.kind === "worlds") {
    // Only the Timeline view selects rows; the Diff and Forks views scroll their own lists,
    // so arrow keys must not silently drift the hidden timeline cursor there.
    return payload.view === "timeline" ? payload.rows.length : 0;
  }
  if (payload.kind === "queue") {
    return payload.items.length;
  }
  if (payload.kind === "notifications") {
    return payload.notifications.length;
  }
  if (payload.kind === "inbox") {
    return payload.items.length;
  }
  if (payload.kind === "inspect") {
    return payload.sections.length;
  }
  if (payload.kind === "cockpitArchive") {
    return payload.items.length;
  }
  if (payload.kind === "select") {
    return payload.options.length;
  }
  if (payload.kind === "skills") {
    return payload.items.length;
  }
  if (
    payload.kind === "commandPalette" ||
    payload.kind === "modelPicker" ||
    payload.kind === "providerPicker" ||
    payload.kind === "thinkingPicker" ||
    payload.kind === "authMethodPicker"
  ) {
    return payload.items.length;
  }
  return undefined;
}

export function getOverlayPageStep(viewportRows: number): number {
  return Math.max(4, Math.floor(Math.max(10, viewportRows - 8) / 2));
}
