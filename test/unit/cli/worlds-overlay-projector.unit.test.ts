import { describe, expect, test } from "bun:test";
import {
  buildWorldsOverlayPayload,
  type WorldsRowInput,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/projectors/worlds.js";
import { selectableItemCount } from "../../../packages/brewva-cli/src/shell/overlays/navigation.js";

// The `/worlds` overlay projector (rfc-worlds-operator-panel Phase 1) is a PURE
// integer/selection normalization over runtime-derived rows: it defaults the view,
// marks the current (HEAD) checkpoint, and keeps the cursor on the same world across a
// rebuild. No runtime, no I/O — so it is directly unit-testable.

function row(overrides: Partial<WorldsRowInput> & { checkpointId: string }): WorldsRowInput {
  return {
    turn: 1,
    timestamp: 1,
    promptPreview: "prompt",
    patchSetCountAfter: 0,
    abandoned: false,
    worldStatus: "captured",
    worldId: "sha256:w",
    ...overrides,
  };
}

describe("buildWorldsOverlayPayload", () => {
  test("defaults the view to timeline and marks the current (HEAD) checkpoint", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: "c2",
      rows: [row({ checkpointId: "c1" }), row({ checkpointId: "c2" })],
    });
    expect(payload.kind).toBe("worlds");
    expect(payload.view).toBe("timeline");
    expect(payload.rows.map((entry) => entry.current)).toEqual([false, true]);
  });

  test("selection prefers the SAME checkpoint across a rebuild, not the ordinal", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [row({ checkpointId: "c1" }), row({ checkpointId: "c2" }), row({ checkpointId: "c3" })],
      // The cursor was on c3 at ordinal 2; even with a stale index hint of 0 it must
      // follow the checkpoint, not the ordinal.
      selection: { checkpointId: "c3", index: 0 },
    });
    expect(payload.selectedIndex).toBe(2);
  });

  test("selection falls back to a clamped index when its checkpoint is gone", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [row({ checkpointId: "c1" }), row({ checkpointId: "c2" })],
      selection: { checkpointId: "vanished", index: 9 },
    });
    expect(payload.selectedIndex).toBe(1);
  });

  test("empty timeline resolves selection to 0 and preserves worldsEnabled", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: false,
      currentCheckpointId: null,
      rows: [],
    });
    expect(payload.selectedIndex).toBe(0);
    expect(payload.rows).toEqual([]);
    expect(payload.worldsEnabled).toBe(false);
  });

  test("carries each row's world status and id through unchanged", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [
        row({ checkpointId: "c1", worldStatus: "capture_failed", worldId: null }),
        row({ checkpointId: "c2", worldStatus: "not_captured", worldId: null }),
        row({ checkpointId: "c3", worldStatus: "captured", worldId: "sha256:abc" }),
      ],
    });
    expect(payload.rows.map((entry) => entry.worldStatus)).toEqual([
      "capture_failed",
      "not_captured",
      "captured",
    ]);
    expect(payload.rows[2]?.worldId).toBe("sha256:abc");
  });

  test("the overlay reports its row count as selectable so up/down navigation works", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [row({ checkpointId: "c1" }), row({ checkpointId: "c2" }), row({ checkpointId: "c3" })],
    });
    // Regression guard: selectableItemCount is a non-exhaustive if-chain, so a missing
    // worlds branch silently freezes the cursor at row 0 — the panel's core failure mode.
    expect(selectableItemCount(payload)).toBe(3);
  });

  test("defaults to the timeline view with a null diff", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [row({ checkpointId: "c1" })],
    });
    expect(payload.view).toBe("timeline");
    expect(payload.diff).toBe(null);
    expect(payload.diffScrollOffset).toBe(0);
  });

  test("carries the diff view and its loaded content through unchanged", () => {
    const payload = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [row({ checkpointId: "c1" })],
      view: "diff",
      diff: {
        checkpointId: "c1",
        turn: 3,
        available: true,
        files: [{ path: "a.ts", change: "added" }],
        added: 1,
        modified: 0,
        deleted: 0,
      },
    });
    expect(payload.view).toBe("diff");
    expect(payload.diff?.files).toEqual([{ path: "a.ts", change: "added" }]);
  });

  test("carries forks lanes through, defaulting to empty with zero scroll", () => {
    const empty = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [],
    });
    expect(empty.forks).toEqual([]);
    expect(empty.forksScrollOffset).toBe(0);
    const withForks = buildWorldsOverlayPayload({
      sessionId: "s",
      worldsEnabled: true,
      currentCheckpointId: null,
      rows: [],
      view: "forks",
      forks: [
        {
          eventId: "e1",
          timestamp: 1,
          outcome: "applied",
          workerIds: ["w1"],
          appliedPathCount: 2,
          conflictPaths: [],
          reason: "already_applied",
        },
      ],
    });
    expect(withForks.view).toBe("forks");
    expect(withForks.forks.map((lane) => lane.outcome)).toEqual(["applied"]);
    expect(withForks.forks[0]?.reason).toBe("already_applied");
  });
});
