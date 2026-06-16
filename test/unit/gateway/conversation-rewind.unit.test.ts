import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS3: the conversation-only rewind executor is a real, compensation-free fork
// wired end to end: record a checkpoint -> it projects as active/rewindable ->
// rewind re-anchors and records a durable completion -> the state reflects it.
describe("conversation-fork rewind executor (RFC WS3)", () => {
  function adapter() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-rewind-")) });
  }

  test("a recorded checkpoint becomes rewindable and a conversation rewind succeeds", () => {
    const rewind = adapter().ops.session.rewind;
    const sessionId = "rewind-ok-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });

    const before = rewind.getState(sessionId);
    expect(before.rewindAvailable).toBe(true);
    expect(before.checkpoints).toHaveLength(1);

    const result = rewind.rewind(sessionId, { mode: "conversation", summary: "carry" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected rewind ok");
    expect(result.mode).toBe("conversation");

    const after = rewind.getState(sessionId);
    expect(after.latestRewind?.mode).toBe("conversation");
  });

  test("rewinding to an earlier checkpoint abandons the later one", () => {
    const rewind = adapter().ops.session.rewind;
    const sessionId = "rewind-abandon-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-2" });

    const checkpoints = rewind.getState(sessionId).checkpoints;
    expect(checkpoints).toHaveLength(2);
    const [first, second] = checkpoints;

    const result = rewind.rewind(sessionId, {
      mode: "conversation",
      checkpointId: first?.checkpointId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected rewind ok");
    expect(result.abandonedCheckpointIds).toEqual([second?.checkpointId ?? ""]);

    const after = rewind.getState(sessionId).checkpoints;
    expect(
      after.find((checkpoint) => checkpoint.checkpointId === second?.checkpointId)?.status,
    ).toBe("undone");
  });

  test("workspace (both) rewind succeeds, rolling back no patch sets when none exist", () => {
    const rewind = adapter().ops.session.rewind;
    const sessionId = "rewind-workspace-session";
    rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });

    const result = rewind.rewind(sessionId, { mode: "both" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected both-mode rewind ok");
    expect(result.mode).toBe("both");
    expect(result.patchSetIds).toEqual([]);
  });
});
