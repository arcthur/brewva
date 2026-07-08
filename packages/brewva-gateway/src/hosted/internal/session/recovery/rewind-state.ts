import type {
  SessionRewindMode,
  SessionRewindState,
  SessionRewindSummary,
} from "@brewva/brewva-vocabulary/session";

type SessionRewindCheckpointRecord = SessionRewindState["checkpoints"][number];
type SessionRewindRecord = NonNullable<SessionRewindState["latestRewind"]>;
type SessionRewindTrigger = SessionRewindRecord["trigger"];

// RFC WS3 read-side: project the durable SessionRewindState from the tape. A
// session_rewind_checkpoint event is an "active" checkpoint until a later
// session.rewind.completed event names it among the checkpoints it rewound past
// (then it is "undone"), and a session.redo.completed event flips it back to
// "redone". Pure and no-cache; the executor's write-side populates the events
// this reads.

const SESSION_REWIND_CHECKPOINT_EVENT_TYPE = "session_rewind_checkpoint";
const SESSION_REWIND_COMPLETED_EVENT_TYPE = "session.rewind.completed";
const SESSION_REDO_COMPLETED_EVENT_TYPE = "session.redo.completed";
const TURN_STARTED_EVENT_TYPE = "turn.started";

type SessionRedoRecord = SessionRewindState["redoStack"][number];

export interface RewindStateEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload?: Record<string, unknown>;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function toRewindRecord(event: RewindStateEvent): SessionRewindRecord {
  const payload = event.payload ?? {};
  const trigger: SessionRewindTrigger = payload.trigger === "undo" ? "undo" : "rewind";
  const mode: SessionRewindMode =
    payload.mode === "conversation" || payload.mode === "code" ? payload.mode : "both";
  const summary: SessionRewindSummary = payload.summary === "none" ? "none" : "carry";
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    checkpointId: str(payload.checkpointId, ""),
    trigger,
    mode,
    summary,
    abandonedCheckpointIds: strArray(payload.abandonedCheckpointIds),
    patchSetIds: strArray(payload.patchSetIds),
    rollbackResults: [],
    returnLeafEntryId:
      typeof payload.returnLeafEntryId === "string" ? payload.returnLeafEntryId : null,
  };
}

export function projectRewindState(
  sessionId: string,
  events: readonly RewindStateEvent[],
): SessionRewindState {
  // Apply rewind and redo completions in order to derive each checkpoint's status.
  const undoneBy = new Map<string, RewindStateEvent>();
  const redone = new Set<string>();
  let latestRewind: SessionRewindRecord | undefined;
  let boundaryIndex = -1;
  events.forEach((event, index) => {
    if (event.type === SESSION_REWIND_COMPLETED_EVENT_TYPE) {
      for (const checkpointId of strArray(event.payload?.abandonedCheckpointIds)) {
        undoneBy.set(checkpointId, event);
        redone.delete(checkpointId);
      }
      latestRewind = toRewindRecord(event);
      // A code-only rewind is a pure workspace operation: it abandons nothing
      // and must not move the conversation redo boundary, or a file restore
      // would resurrect a redo stack that divergent checkpoints superseded.
      if (str(event.payload?.mode, "") !== "code") {
        boundaryIndex = index;
      }
    } else if (event.type === SESSION_REDO_COMPLETED_EVENT_TYPE) {
      const checkpointId = str(event.payload?.checkpointId, "");
      if (checkpointId) {
        redone.add(checkpointId);
        undoneBy.delete(checkpointId);
      }
      boundaryIndex = index;
    }
  });

  let turn = 0;
  let lastCheckpointIndex = -1;
  const checkpoints: SessionRewindCheckpointRecord[] = [];
  events.forEach((event, index) => {
    if (event.type === TURN_STARTED_EVENT_TYPE) {
      turn += 1;
      return;
    }
    if (event.type !== SESSION_REWIND_CHECKPOINT_EVENT_TYPE) return;
    lastCheckpointIndex = index;
    const payload = event.payload ?? {};
    const checkpointId = str(payload.checkpointId, event.id);
    const status = redone.has(checkpointId)
      ? "redone"
      : undoneBy.has(checkpointId)
        ? "undone"
        : "active";
    checkpoints.push({
      checkpointId,
      sessionId,
      turnId: str(payload.turnId, ""),
      reasoningCheckpointId: str(payload.reasoningCheckpointId, ""),
      leafEntryId: typeof payload.leafEntryId === "string" ? payload.leafEntryId : null,
      turn: typeof payload.turn === "number" ? payload.turn : turn,
      eventId: event.id,
      timestamp: event.timestamp,
      status,
    });
  });

  const active = checkpoints.filter(
    (checkpoint) => checkpoint.status === "active" || checkpoint.status === "redone",
  );
  // A checkpoint recorded after the last rewind/redo diverges the branch and
  // supersedes the redo window (RFC: a new checkpoint supersedes redo entries).
  const superseded = lastCheckpointIndex > boundaryIndex;
  const undoneCheckpoints = checkpoints.filter((checkpoint) => checkpoint.status === "undone");
  const redoStack: SessionRedoRecord[] = superseded
    ? []
    : undoneCheckpoints.map((checkpoint) => {
        const rewindEvent = undoneBy.get(checkpoint.checkpointId);
        const mode = rewindEvent?.payload?.mode;
        return {
          eventId: rewindEvent?.id ?? "",
          timestamp: rewindEvent?.timestamp ?? checkpoint.timestamp,
          checkpointId: checkpoint.checkpointId,
          mode: mode === "code" || mode === "both" ? mode : "conversation",
          patchSetIds: [],
          redoResults: [],
          returnLeafEntryId: checkpoint.leafEntryId,
        };
      });

  return {
    checkpoints,
    rewindAvailable: active.length > 0,
    redoAvailable: redoStack.length > 0,
    redoStack,
    latestRewindable: active.at(-1),
    // Tie the surfaced redo target to redo availability: once a divergent
    // checkpoint supersedes the window, there is no honest next-redoable target.
    nextRedoable: superseded ? undefined : undoneCheckpoints.at(-1),
    latestRewind,
  };
}
