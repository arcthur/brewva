import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS4 property fixture: walk the rewind/redo/new-checkpoint/rewind-again
// lattice and assert the state machine stays consistent at every step — no crash,
// correct active/undone/redone transitions, and supersession when work diverges.
describe("rewind/redo lattice consistency (RFC WS4)", () => {
  function rewindOps() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-lattice-")) }).ops
      .session.rewind;
  }

  const sessionId = "lattice-session";
  const statusOf = (rewind: ReturnType<typeof rewindOps>, checkpointId: string) =>
    rewind.getState(sessionId).checkpoints.find((c) => c.checkpointId === checkpointId)?.status;

  test("rewind -> redo -> new checkpoint -> rewind-again stays consistent", () => {
    const rewind = rewindOps();
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-2" });
    const [cp1, cp2] = rewind.getState(sessionId).checkpoints;
    const id1 = cp1?.checkpointId ?? "";
    const id2 = cp2?.checkpointId ?? "";

    // Rewind to cp1: cp2 becomes undone and redoable.
    expect(rewind.rewind(sessionId, { mode: "conversation", checkpointId: id1 }).ok).toBe(true);
    expect(statusOf(rewind, id1)).toBe("active");
    expect(statusOf(rewind, id2)).toBe("undone");
    expect(rewind.getState(sessionId).redoAvailable).toBe(true);

    // Redo: cp2 is reapplied (redone) and the redo window drains.
    expect(rewind.redo(sessionId).ok).toBe(true);
    expect(statusOf(rewind, id2)).toBe("redone");
    expect(rewind.getState(sessionId).redoAvailable).toBe(false);

    // New checkpoint (divergent work), then rewind again to cp1.
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-3" });
    const id3 = rewind.getState(sessionId).checkpoints.at(-1)?.checkpointId ?? "";
    expect(rewind.rewind(sessionId, { mode: "conversation", checkpointId: id1 }).ok).toBe(true);
    expect(statusOf(rewind, id1)).toBe("active");
    expect(statusOf(rewind, id3)).toBe("undone");

    // The state machine never produced an inconsistent (e.g. both-active) view.
    const finalActive = rewind
      .getState(sessionId)
      .checkpoints.filter((c) => c.status === "active" || c.status === "redone");
    expect(finalActive.map((c) => c.checkpointId)).toEqual([id1]);
  });
});
