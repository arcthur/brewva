import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS3: conversation redo reapplies the most recent undone rewind, with
// supersession — a new checkpoint after the rewind diverges the branch and makes
// the redo window unavailable.
describe("conversation redo executor (RFC WS3)", () => {
  function rewindOps() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-redo-")) }).ops
      .session.rewind;
  }

  test("redo reapplies the checkpoint a conversation rewind had undone", () => {
    const rewind = rewindOps();
    const sessionId = "redo-ok-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-2" });
    const [first, second] = rewind.getState(sessionId).checkpoints;

    rewind.rewind(sessionId, { mode: "conversation", checkpointId: first?.checkpointId });
    expect(rewind.getState(sessionId).redoAvailable).toBe(true);

    const redo = rewind.redo(sessionId);
    expect(redo.ok).toBe(true);
    if (!redo.ok) throw new Error("expected redo ok");
    expect(redo.checkpoint.checkpointId).toBe(second?.checkpointId ?? "");

    const after = rewind.getState(sessionId).checkpoints;
    expect(
      after.find((checkpoint) => checkpoint.checkpointId === second?.checkpointId)?.status,
    ).toBe("redone");
  });

  test("redo without any prior rewind is no_redo", () => {
    const rewind = rewindOps();
    const sessionId = "redo-empty-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });

    const redo = rewind.redo(sessionId);
    expect(redo.ok).toBe(false);
    if (redo.ok) throw new Error("expected no_redo");
    expect(redo.reason).toBe("no_redo");
  });

  test("a checkpoint recorded after a rewind supersedes the redo window", () => {
    const rewind = rewindOps();
    const sessionId = "redo-superseded-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-2" });
    const [first] = rewind.getState(sessionId).checkpoints;

    rewind.rewind(sessionId, { mode: "conversation", checkpointId: first?.checkpointId });
    // New work diverges the branch.
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-3" });

    expect(rewind.getState(sessionId).redoAvailable).toBe(false);
    const redo = rewind.redo(sessionId);
    expect(redo.ok).toBe(false);
    if (redo.ok) throw new Error("expected superseded redo to fail");
    expect(redo.reason).toBe("no_redo");
  });
});
