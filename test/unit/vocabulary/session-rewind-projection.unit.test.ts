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
      { id: "p1", sessionId, type: "source_patch_applied", timestamp: 3, payload: { ok: true } },
      { id: "p2", sessionId, type: "source_patch_applied", timestamp: 4, payload: { ok: true } },
      { id: "p3", sessionId, type: "source_patch_applied", timestamp: 5, payload: { ok: false } },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.checkpointId).toBe("cp1");
    expect(result[0]?.turn).toBe(1);
    expect(result[0]?.patchSetCountAfter).toBe(2);
    expect(result[0]?.promptPreview).toBe("fix the bug");
    expect(result[0]?.lineage).toEqual({ kind: "active" });
    // No world block rode this checkpoint → not_captured (the zero-I/O projection view).
    expect(result[0]?.world).toEqual({ status: "not_captured" });
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

  test("projects a captured world from the checkpoint's brewva.world.v1 block", () => {
    const result = targets([
      {
        id: "cp1",
        sessionId,
        type: "session_rewind_checkpoint",
        timestamp: 2,
        payload: { world: { schema: "brewva.world.v1", id: "sha256:w1" } },
      },
    ]);
    expect(result[0]?.world).toEqual({ status: "captured", worldId: "sha256:w1" });
  });

  test("projects capture_failed when the checkpoint's world block recorded an error", () => {
    const result = targets([
      {
        id: "cp1",
        sessionId,
        type: "session_rewind_checkpoint",
        timestamp: 2,
        payload: { world: { schema: "brewva.world.v1", error: "disk full" } },
      },
    ]);
    expect(result[0]?.world).toEqual({ status: "capture_failed" });
  });

  test("a malformed world block (right schema, neither id nor error) projects not_captured", () => {
    const result = targets([
      {
        id: "cp1",
        sessionId,
        type: "session_rewind_checkpoint",
        timestamp: 2,
        payload: { world: { schema: "brewva.world.v1" } },
      },
    ]);
    expect(result[0]?.world).toEqual({ status: "not_captured" });
  });

  test("returns no targets for a session without rewind checkpoints", () => {
    expect(targets([{ id: "e1", sessionId, type: "turn.started", timestamp: 1 }])).toEqual([]);
  });
});
