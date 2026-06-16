import { describe, expect, test } from "bun:test";
import {
  projectRewindState,
  type RewindStateEvent,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/recovery/rewind-state.js";

const sessionId = "rewind-state-session";

describe("rewind state projection (RFC WS3)", () => {
  test("an empty session has no checkpoints and no rewind available", () => {
    const state = projectRewindState(sessionId, []);
    expect(state.checkpoints).toEqual([]);
    expect(state.rewindAvailable).toBe(false);
    expect(state.latestRewindable === undefined).toBe(true);
  });

  test("a recorded checkpoint is active and rewindable, bound to its event", () => {
    const events: RewindStateEvent[] = [
      { id: "t1", type: "turn.started", timestamp: 1 },
      {
        id: "cp1",
        type: "session_rewind_checkpoint",
        timestamp: 2,
        payload: { reasoningCheckpointId: "rc1", leafEntryId: "leaf-1" },
      },
    ];
    const state = projectRewindState(sessionId, events);

    expect(state.rewindAvailable).toBe(true);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]?.checkpointId).toBe("cp1");
    expect(state.checkpoints[0]?.status).toBe("active");
    expect(state.checkpoints[0]?.reasoningCheckpointId).toBe("rc1");
    expect(state.checkpoints[0]?.turn).toBe(1);
    expect(state.latestRewindable?.checkpointId).toBe("cp1");
  });

  test("a completed rewind marks the checkpoints it abandoned as undone", () => {
    const events: RewindStateEvent[] = [
      { id: "cp1", type: "session_rewind_checkpoint", timestamp: 2 },
      {
        id: "rw1",
        type: "session.rewind.completed",
        timestamp: 5,
        payload: { checkpointId: "cp0", mode: "conversation", abandonedCheckpointIds: ["cp1"] },
      },
    ];
    const state = projectRewindState(sessionId, events);

    expect(state.checkpoints[0]?.status).toBe("undone");
    expect(state.rewindAvailable).toBe(false);
    expect(state.latestRewind?.mode).toBe("conversation");
    expect(state.latestRewind?.eventId).toBe("rw1");
  });
});
