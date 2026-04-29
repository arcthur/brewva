import type { SessionRewindDivergenceNote, SessionRewindSummary } from "@brewva/brewva-runtime";

type RewindCompletedSummary = Extract<SessionRewindSummary, "carry" | "none">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readSessionRewindCompletedPayload(payload: unknown): {
  revertEventId: string;
  summary: RewindCompletedSummary;
} | null {
  if (!isRecord(payload) || payload.ok !== true) {
    return null;
  }
  const revertEventId = readOptionalString(payload.reasoningRevertEventId);
  const summary =
    payload.summary === "none" ? "none" : payload.summary === "carry" ? "carry" : null;
  return revertEventId && summary ? { revertEventId, summary } : null;
}

export function readSessionRewindDivergenceNote(
  payload: unknown,
): Pick<SessionRewindDivergenceNote, "kind" | "text" | "patchSetCount"> | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.divergenceNote)) {
    return null;
  }
  const divergence = payload.divergenceNote;
  const kind =
    divergence.kind === "workspace_ahead" || divergence.kind === "conversation_ahead"
      ? divergence.kind
      : null;
  const text = readOptionalString(divergence.text);
  const patchSetCount =
    typeof divergence.patchSetCount === "number" && Number.isFinite(divergence.patchSetCount)
      ? Math.max(0, Math.floor(divergence.patchSetCount))
      : null;
  return kind && text && patchSetCount !== null ? { kind, text, patchSetCount } : null;
}
