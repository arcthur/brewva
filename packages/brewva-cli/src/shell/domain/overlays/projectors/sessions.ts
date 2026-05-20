import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/protocol";
import { DEFAULT_SESSION_TITLE } from "@brewva/brewva-runtime/protocol";
import type { OperatorSurfaceSnapshot } from "../../operator-snapshot.js";
import { fuzzyScore, normalizeSearchQuery } from "../../search-scoring.js";
import type { CliSessionsOverlayPayload } from "../payloads.js";

export type CliSessionsOverlayRow =
  | {
      kind: "group";
      label: string;
    }
  | {
      kind: "session";
      session: BrewvaReplaySession;
      sessionIndex: number;
    };

function sessionsOverlayGroupLabel(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Today";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  const label = date.toDateString();
  return label === new Date(now).toDateString() ? "Today" : label;
}

function matchesSessionsOverlayQuery(
  session: BrewvaReplaySession,
  query: string,
  now: number,
): boolean {
  if (!normalizeSearchQuery(query)) {
    return true;
  }
  return (
    fuzzyScore(query, session.title ?? "") !== null ||
    fuzzyScore(query, sessionsOverlayGroupLabel(session.lastEventAt, now)) !== null
  );
}

export function buildSessionsOverlayRows(
  sessions: readonly BrewvaReplaySession[],
  now = Date.now(),
): CliSessionsOverlayRow[] {
  const rows: CliSessionsOverlayRow[] = [];
  let previousGroup: string | undefined;
  for (const [sessionIndex, session] of sessions.entries()) {
    const group = sessionsOverlayGroupLabel(session.lastEventAt, now);
    if (group !== previousGroup) {
      rows.push({ kind: "group", label: group });
      previousGroup = group;
    }
    rows.push({ kind: "session", session, sessionIndex });
  }
  return rows;
}

export function mergeSessionsOverlayRows(
  snapshot: OperatorSurfaceSnapshot,
  currentSessionId: string,
): BrewvaReplaySession[] {
  const hasCurrentInSnapshot = snapshot.sessions.some(
    (session) => session.sessionId === currentSessionId,
  );
  const placeholderCurrent = {
    sessionId: asBrewvaSessionId(currentSessionId),
    eventCount: 0,
    lastEventAt: 0,
    title: DEFAULT_SESSION_TITLE,
  } satisfies BrewvaReplaySession;
  return hasCurrentInSnapshot ? [...snapshot.sessions] : [placeholderCurrent, ...snapshot.sessions];
}

export function orderSessionsByStableIds(
  sessions: readonly BrewvaReplaySession[],
  stableIds: readonly string[],
): BrewvaReplaySession[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const used = new Set<string>();
  const out: BrewvaReplaySession[] = [];
  for (const id of stableIds) {
    const row = byId.get(id);
    if (row) {
      out.push(row);
      used.add(id);
    }
  }
  for (const session of sessions) {
    const id = session.sessionId;
    if (!used.has(id)) {
      out.push(session);
    }
  }
  return out;
}

/**
 * Pure state step for the sessions overlay list: lock order on first call, keep it across snapshot
 * reshuffles, and optionally promote the current session after an interactive submit + eventCount bump.
 */
export function reconcileSessionsOverlayStableIds(input: {
  mergedSessions: readonly BrewvaReplaySession[];
  currentSessionId: string;
  stableOrderIds: readonly string[] | undefined;
  lastEventCounts: ReadonlyMap<string, number>;
  userPromptReorderGeneration: number;
  lastAppliedUserPromptReorderGeneration: number;
}): {
  stableOrderIds: string[];
  lastAppliedUserPromptReorderGeneration: number;
} {
  const merged = input.mergedSessions;
  if (input.stableOrderIds === undefined) {
    return {
      stableOrderIds: merged.map((session) => session.sessionId),
      lastAppliedUserPromptReorderGeneration: input.lastAppliedUserPromptReorderGeneration,
    };
  }

  const availableIds = new Set(merged.map((session) => session.sessionId));
  const currentRow = merged.find((session) => session.sessionId === input.currentSessionId);
  const previousCurrentCount = input.lastEventCounts.get(input.currentSessionId) ?? 0;

  let nextOrder = [...input.stableOrderIds].filter((sessionId) => availableIds.has(sessionId));
  for (const session of merged) {
    const sid = session.sessionId;
    if (!nextOrder.includes(sid)) {
      nextOrder.push(sid);
    }
  }

  let lastApplied = input.lastAppliedUserPromptReorderGeneration;
  if (
    input.userPromptReorderGeneration > input.lastAppliedUserPromptReorderGeneration &&
    currentRow !== undefined &&
    currentRow.eventCount > previousCurrentCount
  ) {
    nextOrder = [
      input.currentSessionId,
      ...nextOrder.filter((sessionId) => sessionId !== input.currentSessionId),
    ];
    lastApplied = input.userPromptReorderGeneration;
  }

  return {
    stableOrderIds: nextOrder,
    lastAppliedUserPromptReorderGeneration: lastApplied,
  };
}

export function buildSessionsOverlayPayload(input: {
  snapshot: OperatorSurfaceSnapshot;
  currentSessionId: string;
  draftsBySessionId: ReadonlyMap<string, { text: string }>;
  currentComposerText: string;
  query?: string;
  /**
   * Replay rows in display order — used by the sessions overlay to keep keyboard order stable
   * regardless of backend `lastEventAt` reshuffles until the user sends a prompt in the current session.
   */
  replaySessionsForOverlay?: readonly BrewvaReplaySession[];
  selection?: {
    sessionId?: string;
    index?: number;
  };
}): CliSessionsOverlayPayload {
  const query = input.query ?? "";
  const now = Date.now();
  const replaySessions = input.replaySessionsForOverlay
    ? [...input.replaySessionsForOverlay]
    : mergeSessionsOverlayRows(input.snapshot, input.currentSessionId);
  const sessions = replaySessions.filter((session) =>
    matchesSessionsOverlayQuery(session, query, now),
  );
  const selectedIndexById =
    typeof input.selection?.sessionId === "string"
      ? sessions.findIndex((session) => session.sessionId === input.selection?.sessionId)
      : -1;
  const fallbackCurrentIndex = sessions.findIndex(
    (session) => session.sessionId === input.currentSessionId,
  );
  const draftStateBySessionId = Object.fromEntries(
    [...input.draftsBySessionId.entries()].map(([sessionId, draft]) => [
      sessionId,
      summarizeDraftPreview(draft.text),
    ]),
  ) as CliSessionsOverlayPayload["draftStateBySessionId"];

  if (input.currentComposerText.trim().length > 0) {
    draftStateBySessionId[input.currentSessionId] = summarizeDraftPreview(
      input.currentComposerText,
    );
  } else {
    delete draftStateBySessionId[input.currentSessionId];
  }

  return {
    kind: "sessions",
    query,
    sessions,
    currentSessionId: input.currentSessionId,
    draftStateBySessionId,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : fallbackCurrentIndex >= 0
          ? fallbackCurrentIndex
          : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, sessions.length - 1))),
  };
}

export function summarizeDraftPreview(text: string): {
  characters: number;
  lines: number;
  preview: string;
} {
  const trimmed = text.trim();
  return {
    characters: text.length,
    lines: Math.max(1, text.split(/\r?\n/u).length),
    preview: trimmed.split(/\r?\n/u)[0]?.slice(0, 96) ?? "",
  };
}
