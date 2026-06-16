import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// P1 regression: the rewind/redo engine must produce the exact contract the live
// interactive shell and a cold-hydration session store both consume. The shell
// switches the in-memory leaf from `result.reasoningRevert`; the session store
// rebuilds the leaf on restart from a canonical `reasoning.revert` tape event plus
// an `ok`/`reasoningRevertEventId`-bearing `session.rewind.completed` receipt.
// Emitting a private `reasoning_revert_recorded` kind with a bare payload (no
// `targetLeafEntryId`/`continuityPacket`, no `ok`) left both paths dead: `/rewind`
// returned ok and wrote the tape, but neither the live leaf nor a rehydrated leaf
// actually moved.

type AnyAdapter = ReturnType<typeof createHostedRuntimeAdapter>;

function freshAdapter(): AnyAdapter {
  return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-leaf-")) });
}

function innerPayload(
  adapter: AnyAdapter,
  sessionId: string,
  kind: string,
): Record<string, unknown> | undefined {
  for (const event of adapter.runtime.tape.list(sessionId)) {
    const envelope = event.payload as { kind?: unknown; payload?: unknown } | undefined;
    if (envelope?.kind === kind) {
      return envelope.payload as Record<string, unknown>;
    }
  }
  return undefined;
}

function twoCheckpointSession(adapter: AnyAdapter, sessionId: string): string {
  // A live session store seeds the lineage root on the empty session (as the hosted
  // runtime would) so a later cold rebuild can hydrate from the same tape.
  const liveStore = new HostedRuntimeTapeSessionStore(adapter, sessionId);
  expect(liveStore.getSessionId()).toBe(sessionId);
  adapter.ops.session.rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-1" });
  adapter.ops.session.lifecycle.turnStarted({ sessionId, turn: 1, payload: {} });
  adapter.ops.session.rewind.recordCheckpoint(sessionId, { leafEntryId: "leaf-2" });
  return adapter.ops.session.rewind.getState(sessionId).checkpoints[0]?.checkpointId ?? "";
}

describe("rewind/redo live-leaf contract (P1)", () => {
  test("conversation rewind returns reasoningRevert for the live shell", () => {
    const adapter = freshAdapter();
    const sessionId = "leaf-session";
    const firstCheckpoint = twoCheckpointSession(adapter, sessionId);

    const result = adapter.ops.session.rewind.rewind(sessionId, {
      mode: "conversation",
      summary: "carry",
      summaryHint: "carry the plan",
      checkpointId: firstCheckpoint,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected rewind ok");
    expect(result.reasoningRevert?.targetLeafEntryId).toBe("leaf-1");
    expect(result.reasoningRevert?.continuityPacket.text).toBe("carry the plan");
  });

  test("rewind emits a canonical reasoning.revert the session store reads on hydration", () => {
    const adapter = freshAdapter();
    const sessionId = "hydration-session";
    const firstCheckpoint = twoCheckpointSession(adapter, sessionId);

    adapter.ops.session.rewind.rewind(sessionId, {
      mode: "conversation",
      summary: "none",
      checkpointId: firstCheckpoint,
    });

    const revert = innerPayload(adapter, sessionId, "reasoning.revert");
    expect(revert?.targetLeafEntryId).toBe("leaf-1");
    expect((revert?.continuityPacket as { text?: unknown } | undefined)?.text).toContain(
      "checkpoint",
    );

    const completed = innerPayload(adapter, sessionId, "session.rewind.completed");
    expect(completed?.ok).toBe(true);
    expect(typeof completed?.reasoningRevertEventId).toBe("string");
    expect(completed?.reasoningRevertEventId).not.toBe("");
  });

  test("redo returns a reasoningCheckpoint and honors a specific checkpointId", () => {
    const adapter = freshAdapter();
    const sessionId = "redo-session";
    const firstCheckpoint = twoCheckpointSession(adapter, sessionId);
    const secondCheckpoint =
      adapter.ops.session.rewind.getState(sessionId).checkpoints[1]?.checkpointId ?? "";

    // Rewind to the first checkpoint so the second is undone (redoable).
    adapter.ops.session.rewind.rewind(sessionId, {
      mode: "conversation",
      checkpointId: firstCheckpoint,
    });

    // A non-redoable id is rejected, not silently coerced to nextRedoable.
    const wrongTarget = adapter.ops.session.rewind.redo(sessionId, {
      checkpointId: firstCheckpoint,
    });
    expect(wrongTarget.ok).toBe(false);
    if (wrongTarget.ok) throw new Error("expected redo of an active checkpoint to fail");
    expect(wrongTarget.reason).toBe("checkpoint_not_redoable");

    const redo = adapter.ops.session.rewind.redo(sessionId, { checkpointId: secondCheckpoint });
    expect(redo.ok).toBe(true);
    if (!redo.ok) throw new Error("expected redo ok");
    expect(typeof redo.reasoningCheckpoint?.checkpointId).toBe("string");
    expect(redo.returnLeafEntryId).toBe("leaf-2");
  });

  // A cold session store rebuilt from the same tape must land on the same leaf the
  // live engine moved to — for `carry` and for `redo`, not only `none`. Before the
  // fix the projection re-anchored only on `summary: "none"` and only mapped
  // `session.rewind.completed`, so a default (carry) `/undo` rehydrated to a null
  // leaf and a redo never advanced the rehydrated leaf.
  function coldLeaf(adapter: AnyAdapter, sessionId: string): string | null {
    return new HostedRuntimeTapeSessionStore(adapter, sessionId).getLeafId();
  }

  test("carry rewind re-anchors the cold-hydrated leaf instead of leaving it null", () => {
    const adapter = freshAdapter();
    const sessionId = "carry-cold-session";
    const firstCheckpoint = twoCheckpointSession(adapter, sessionId);

    adapter.ops.session.rewind.rewind(sessionId, {
      mode: "conversation",
      summary: "carry",
      summaryHint: "carry the plan",
      checkpointId: firstCheckpoint,
    });

    expect(coldLeaf(adapter, sessionId)).toBe("leaf-1");
  });

  test("none and carry rewind rehydrate to the same leaf (mode parity)", () => {
    const noneAdapter = freshAdapter();
    const noneCheckpoint = twoCheckpointSession(noneAdapter, "none-cold");
    noneAdapter.ops.session.rewind.rewind("none-cold", {
      mode: "conversation",
      summary: "none",
      checkpointId: noneCheckpoint,
    });

    const carryAdapter = freshAdapter();
    const carryCheckpoint = twoCheckpointSession(carryAdapter, "carry-cold");
    carryAdapter.ops.session.rewind.rewind("carry-cold", {
      mode: "conversation",
      summary: "carry",
      checkpointId: carryCheckpoint,
    });

    expect(coldLeaf(noneAdapter, "none-cold")).toBe("leaf-1");
    expect(coldLeaf(carryAdapter, "carry-cold")).toBe(coldLeaf(noneAdapter, "none-cold"));
  });

  test("redo advances the cold-hydrated leaf forward to the redone checkpoint", () => {
    const adapter = freshAdapter();
    const sessionId = "redo-cold-session";
    const firstCheckpoint = twoCheckpointSession(adapter, sessionId);

    adapter.ops.session.rewind.rewind(sessionId, {
      mode: "conversation",
      checkpointId: firstCheckpoint,
    });
    expect(coldLeaf(adapter, sessionId)).toBe("leaf-1");

    const redo = adapter.ops.session.rewind.redo(sessionId);
    expect(redo.ok).toBe(true);
    // Cold rebuild now maps `session.redo.completed`, so the rehydrated leaf moves
    // forward to the redone checkpoint instead of staying at the rewound one.
    expect(coldLeaf(adapter, sessionId)).toBe("leaf-2");
  });
});
