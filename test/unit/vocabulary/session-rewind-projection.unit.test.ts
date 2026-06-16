import { describe, expect, test } from "bun:test";
import {
  buildSessionRewindProjection,
  listSessionRewindTargets,
} from "@brewva/brewva-vocabulary/session";

type Event = {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  payload?: Record<string, unknown>;
};

const sessionId = "rewind-proj-session";

function targets(events: readonly Event[]) {
  return listSessionRewindTargets(buildSessionRewindProjection({ sessionId, events }));
}

describe("session rewind target projection (RFC WS3)", () => {
  test("projects an active checkpoint with the turn and patch sets recorded after it", () => {
    const result = targets([
      { id: "e1", sessionId, type: "turn.started", timestamp: 1 },
      {
        id: "cp1",
        sessionId,
        type: "session_rewind_checkpoint",
        timestamp: 2,
        payload: { prompt: { text: "fix the bug" } },
      },
      { id: "p1", sessionId, type: "patch.recorded", timestamp: 3 },
      { id: "p2", sessionId, type: "patch.recorded", timestamp: 4 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.checkpointId).toBe("cp1");
    expect(result[0]?.turn).toBe(1);
    expect(result[0]?.patchSetCountAfter).toBe(2);
    expect(result[0]?.promptPreview).toBe("fix the bug");
    expect(result[0]?.lineage).toEqual({ kind: "active" });
  });

  test("marks a checkpoint abandoned when a later completed rewind rewound past it", () => {
    const result = targets([
      { id: "cp1", sessionId, type: "session_rewind_checkpoint", timestamp: 2 },
      {
        id: "rw1",
        sessionId,
        type: "session.rewind.completed",
        timestamp: 5,
        payload: { abandonedCheckpointIds: ["cp1"] },
      },
    ]);

    expect(result[0]?.lineage).toEqual({ kind: "abandoned", rewoundBy: "rw1", rewoundAt: 5 });
  });

  test("returns no targets for a session without rewind checkpoints", () => {
    expect(targets([{ id: "e1", sessionId, type: "turn.started", timestamp: 1 }])).toEqual([]);
  });
});
