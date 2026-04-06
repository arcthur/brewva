import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime";
import {
  MAX_REASONING_CONTINUITY_BYTES,
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  buildReasoningCheckpointPayload,
  buildReasoningRevertPayload,
} from "@brewva/brewva-runtime";
import {
  normalizeReasoningContinuityPacket,
  coerceReasoningContinuityPacket,
} from "../../../packages/brewva-runtime/src/tape/reasoning-events.js";
import { ReasoningReplayEngine } from "../../../packages/brewva-runtime/src/tape/reasoning-replay.js";

function checkpointEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  turn: number;
  checkpointId: string;
  checkpointSequence: number;
  branchId: string;
  branchSequence: number;
  parentCheckpointId?: string | null;
  leafEntryId?: string | null;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: REASONING_CHECKPOINT_EVENT_TYPE,
    timestamp: input.timestamp,
    turn: input.turn,
    payload: buildReasoningCheckpointPayload({
      checkpointId: input.checkpointId,
      checkpointSequence: input.checkpointSequence,
      branchId: input.branchId,
      branchSequence: input.branchSequence,
      parentCheckpointId: input.parentCheckpointId ?? null,
      boundary: "tool_boundary",
      leafEntryId: input.leafEntryId ?? null,
      createdAt: input.timestamp,
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

function revertEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  turn: number;
  revertId: string;
  revertSequence: number;
  toCheckpointId: string;
  fromCheckpointId?: string | null;
  fromBranchId: string;
  newBranchId: string;
  newBranchSequence: number;
  continuity: string;
  targetLeafEntryId?: string | null;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    type: REASONING_REVERT_EVENT_TYPE,
    timestamp: input.timestamp,
    turn: input.turn,
    payload: buildReasoningRevertPayload({
      revertId: input.revertId,
      revertSequence: input.revertSequence,
      toCheckpointId: input.toCheckpointId,
      fromCheckpointId: input.fromCheckpointId ?? null,
      fromBranchId: input.fromBranchId,
      newBranchId: input.newBranchId,
      newBranchSequence: input.newBranchSequence,
      trigger: "operator_request",
      continuityPacket: input.continuity,
      targetLeafEntryId: input.targetLeafEntryId ?? null,
      createdAt: input.timestamp,
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

describe("ReasoningReplayEngine", () => {
  test("tracks active lineage after branch revert and branch continuation", () => {
    const sessionId = "reasoning-replay-lineage";
    const rootBranchId = `${sessionId}:reasoning-branch-0`;
    const branchedId = `${sessionId}:reasoning-branch-1`;
    const events: BrewvaEventRecord[] = [
      checkpointEvent({
        sessionId,
        id: "evt-c1",
        timestamp: 1,
        turn: 1,
        checkpointId: "reasoning-checkpoint-1",
        checkpointSequence: 1,
        branchId: rootBranchId,
        branchSequence: 0,
        leafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c2",
        timestamp: 2,
        turn: 1,
        checkpointId: "reasoning-checkpoint-2",
        checkpointSequence: 2,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-2",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c3",
        timestamp: 3,
        turn: 2,
        checkpointId: "reasoning-checkpoint-3",
        checkpointSequence: 3,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-2",
        leafEntryId: "leaf-3",
      }),
      revertEvent({
        sessionId,
        id: "evt-r1",
        timestamp: 4,
        turn: 2,
        revertId: "reasoning-revert-1",
        revertSequence: 1,
        toCheckpointId: "reasoning-checkpoint-1",
        fromCheckpointId: "reasoning-checkpoint-3",
        fromBranchId: rootBranchId,
        newBranchId: branchedId,
        newBranchSequence: 1,
        continuity: "Resume from the validated checkpoint only.",
        targetLeafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c4",
        timestamp: 5,
        turn: 3,
        checkpointId: "reasoning-checkpoint-4",
        checkpointSequence: 4,
        branchId: branchedId,
        branchSequence: 1,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-4",
      }),
    ];

    const engine = new ReasoningReplayEngine({
      listEvents: () => events,
    });

    const state = engine.replay(sessionId);

    expect(state.rootBranchId).toBe(rootBranchId);
    expect(state.activeBranchId).toBe(branchedId);
    expect(state.activeBranchSequence).toBe(1);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-4");
    expect(state.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-4",
    ]);
    expect(state.latestRevert).toMatchObject({
      revertId: "reasoning-revert-1",
      toCheckpointId: "reasoning-checkpoint-1",
      newBranchId: branchedId,
    });
    expect(state.latestContinuityPacket?.text).toBe("Resume from the validated checkpoint only.");
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-1")).toBe(true);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-3")).toBe(false);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-4")).toBe(true);
  });

  test("observeEvent incrementally updates cached branch state without invalidate", () => {
    const sessionId = "reasoning-replay-observe";
    const rootBranchId = `${sessionId}:reasoning-branch-0`;
    const branchedId = `${sessionId}:reasoning-branch-1`;
    const events: BrewvaEventRecord[] = [
      checkpointEvent({
        sessionId,
        id: "evt-c1",
        timestamp: 1,
        turn: 1,
        checkpointId: "reasoning-checkpoint-1",
        checkpointSequence: 1,
        branchId: rootBranchId,
        branchSequence: 0,
        leafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c2",
        timestamp: 2,
        turn: 1,
        checkpointId: "reasoning-checkpoint-2",
        checkpointSequence: 2,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-2",
      }),
    ];

    const engine = new ReasoningReplayEngine({
      listEvents: () => events,
    });

    const first = engine.replay(sessionId);
    expect(first.activeCheckpointId).toBe("reasoning-checkpoint-2");
    expect(first.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-2",
    ]);

    const revert = revertEvent({
      sessionId,
      id: "evt-r1",
      timestamp: 3,
      turn: 2,
      revertId: "reasoning-revert-1",
      revertSequence: 1,
      toCheckpointId: "reasoning-checkpoint-1",
      fromCheckpointId: "reasoning-checkpoint-2",
      fromBranchId: rootBranchId,
      newBranchId: branchedId,
      newBranchSequence: 1,
      continuity: "Keep only the surviving branch facts.",
      targetLeafEntryId: "leaf-1",
    });
    events.push(revert);
    engine.observeEvent(revert);

    const afterRevert = engine.replay(sessionId);
    expect(afterRevert.activeBranchId).toBe(branchedId);
    expect(afterRevert.activeCheckpointId).toBe("reasoning-checkpoint-1");
    expect(afterRevert.activeLineageCheckpointIds).toEqual(["reasoning-checkpoint-1"]);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-2")).toBe(false);

    const continued = checkpointEvent({
      sessionId,
      id: "evt-c3",
      timestamp: 4,
      turn: 2,
      checkpointId: "reasoning-checkpoint-3",
      checkpointSequence: 3,
      branchId: branchedId,
      branchSequence: 1,
      parentCheckpointId: "reasoning-checkpoint-1",
      leafEntryId: "leaf-3",
    });
    events.push(continued);
    engine.observeEvent(continued);

    const finalState = engine.replay(sessionId);
    expect(finalState.activeCheckpointId).toBe("reasoning-checkpoint-3");
    expect(finalState.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-3",
    ]);
  });

  test("ignores checkpoint events that do not continue from the active branch head", () => {
    const sessionId = "reasoning-replay-invalid-checkpoint";
    const rootBranchId = `${sessionId}:reasoning-branch-0`;
    const branchedId = `${sessionId}:reasoning-branch-1`;
    const events: BrewvaEventRecord[] = [
      checkpointEvent({
        sessionId,
        id: "evt-c1",
        timestamp: 1,
        turn: 1,
        checkpointId: "reasoning-checkpoint-1",
        checkpointSequence: 1,
        branchId: rootBranchId,
        branchSequence: 0,
        leafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c2",
        timestamp: 2,
        turn: 1,
        checkpointId: "reasoning-checkpoint-2",
        checkpointSequence: 2,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-2",
      }),
      revertEvent({
        sessionId,
        id: "evt-r1",
        timestamp: 3,
        turn: 2,
        revertId: "reasoning-revert-1",
        revertSequence: 1,
        toCheckpointId: "reasoning-checkpoint-1",
        fromCheckpointId: "reasoning-checkpoint-2",
        fromBranchId: rootBranchId,
        newBranchId: branchedId,
        newBranchSequence: 1,
        continuity: "Return to the trusted branch root.",
        targetLeafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c-invalid",
        timestamp: 4,
        turn: 3,
        checkpointId: "reasoning-checkpoint-3",
        checkpointSequence: 3,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-2",
        leafEntryId: "leaf-invalid",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c4",
        timestamp: 5,
        turn: 3,
        checkpointId: "reasoning-checkpoint-4",
        checkpointSequence: 4,
        branchId: branchedId,
        branchSequence: 1,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-4",
      }),
    ];

    const engine = new ReasoningReplayEngine({
      listEvents: () => events,
    });

    const state = engine.replay(sessionId);

    expect(state.checkpoints.map((entry) => entry.checkpointId)).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-2",
      "reasoning-checkpoint-4",
    ]);
    expect(state.activeBranchId).toBe(branchedId);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-4");
    expect(state.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-4",
    ]);
  });

  test("valid nested revert moves the active branch twice and preserves a correct lineage", () => {
    const sessionId = "reasoning-replay-nested-revert";
    const branch0 = `${sessionId}:reasoning-branch-0`;
    const branch1 = `${sessionId}:reasoning-branch-1`;
    const branch2 = `${sessionId}:reasoning-branch-2`;
    const events: BrewvaEventRecord[] = [
      checkpointEvent({
        sessionId,
        id: "evt-c1",
        timestamp: 1,
        turn: 1,
        checkpointId: "reasoning-checkpoint-1",
        checkpointSequence: 1,
        branchId: branch0,
        branchSequence: 0,
        leafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c2",
        timestamp: 2,
        turn: 1,
        checkpointId: "reasoning-checkpoint-2",
        checkpointSequence: 2,
        branchId: branch0,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-2",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c3",
        timestamp: 3,
        turn: 2,
        checkpointId: "reasoning-checkpoint-3",
        checkpointSequence: 3,
        branchId: branch0,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-2",
        leafEntryId: "leaf-3",
      }),
      revertEvent({
        sessionId,
        id: "evt-r1",
        timestamp: 4,
        turn: 2,
        revertId: "reasoning-revert-1",
        revertSequence: 1,
        toCheckpointId: "reasoning-checkpoint-1",
        fromCheckpointId: "reasoning-checkpoint-3",
        fromBranchId: branch0,
        newBranchId: branch1,
        newBranchSequence: 1,
        continuity: "First revert to checkpoint-1.",
        targetLeafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c4",
        timestamp: 5,
        turn: 3,
        checkpointId: "reasoning-checkpoint-4",
        checkpointSequence: 4,
        branchId: branch1,
        branchSequence: 1,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-4",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c5",
        timestamp: 6,
        turn: 3,
        checkpointId: "reasoning-checkpoint-5",
        checkpointSequence: 5,
        branchId: branch1,
        branchSequence: 1,
        parentCheckpointId: "reasoning-checkpoint-4",
        leafEntryId: "leaf-5",
      }),
      revertEvent({
        sessionId,
        id: "evt-r2",
        timestamp: 7,
        turn: 3,
        revertId: "reasoning-revert-2",
        revertSequence: 2,
        toCheckpointId: "reasoning-checkpoint-4",
        fromCheckpointId: "reasoning-checkpoint-5",
        fromBranchId: branch1,
        newBranchId: branch2,
        newBranchSequence: 2,
        continuity: "Second revert to checkpoint-4 on the already-reverted branch.",
        targetLeafEntryId: "leaf-4",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c6",
        timestamp: 8,
        turn: 4,
        checkpointId: "reasoning-checkpoint-6",
        checkpointSequence: 6,
        branchId: branch2,
        branchSequence: 2,
        parentCheckpointId: "reasoning-checkpoint-4",
        leafEntryId: "leaf-6",
      }),
    ];

    const engine = new ReasoningReplayEngine({
      listEvents: () => events,
    });
    const state = engine.replay(sessionId);

    expect(state.activeBranchId).toBe(branch2);
    expect(state.activeBranchSequence).toBe(2);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-6");
    expect(state.activeLineageCheckpointIds).toEqual([
      "reasoning-checkpoint-1",
      "reasoning-checkpoint-4",
      "reasoning-checkpoint-6",
    ]);
    expect(state.latestRevert?.revertId).toBe("reasoning-revert-2");
    expect(state.latestRevert?.toCheckpointId).toBe("reasoning-checkpoint-4");
    expect(state.latestContinuityPacket?.text).toBe(
      "Second revert to checkpoint-4 on the already-reverted branch.",
    );
    expect(state.reverts).toHaveLength(2);

    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-1")).toBe(true);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-4")).toBe(true);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-6")).toBe(true);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-2")).toBe(false);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-3")).toBe(false);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-5")).toBe(false);

    expect(state.nextBranchSequence).toBe(3);
    expect(state.nextCheckpointSequence).toBe(7);
    expect(state.nextRevertSequence).toBe(3);
  });

  test("ignores revert events that target superseded checkpoints outside the active lineage", () => {
    const sessionId = "reasoning-replay-invalid-revert";
    const rootBranchId = `${sessionId}:reasoning-branch-0`;
    const branchedId = `${sessionId}:reasoning-branch-1`;
    const events: BrewvaEventRecord[] = [
      checkpointEvent({
        sessionId,
        id: "evt-c1",
        timestamp: 1,
        turn: 1,
        checkpointId: "reasoning-checkpoint-1",
        checkpointSequence: 1,
        branchId: rootBranchId,
        branchSequence: 0,
        leafEntryId: "leaf-1",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c2",
        timestamp: 2,
        turn: 1,
        checkpointId: "reasoning-checkpoint-2",
        checkpointSequence: 2,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-1",
        leafEntryId: "leaf-2",
      }),
      checkpointEvent({
        sessionId,
        id: "evt-c3",
        timestamp: 3,
        turn: 2,
        checkpointId: "reasoning-checkpoint-3",
        checkpointSequence: 3,
        branchId: rootBranchId,
        branchSequence: 0,
        parentCheckpointId: "reasoning-checkpoint-2",
        leafEntryId: "leaf-3",
      }),
      revertEvent({
        sessionId,
        id: "evt-r1",
        timestamp: 4,
        turn: 2,
        revertId: "reasoning-revert-1",
        revertSequence: 1,
        toCheckpointId: "reasoning-checkpoint-1",
        fromCheckpointId: "reasoning-checkpoint-3",
        fromBranchId: rootBranchId,
        newBranchId: branchedId,
        newBranchSequence: 1,
        continuity: "Keep only the original checkpoint facts.",
        targetLeafEntryId: "leaf-1",
      }),
      revertEvent({
        sessionId,
        id: "evt-r-invalid",
        timestamp: 5,
        turn: 3,
        revertId: "reasoning-revert-2",
        revertSequence: 2,
        toCheckpointId: "reasoning-checkpoint-2",
        fromCheckpointId: "reasoning-checkpoint-1",
        fromBranchId: branchedId,
        newBranchId: `${sessionId}:reasoning-branch-2`,
        newBranchSequence: 2,
        continuity: "This should be ignored because checkpoint-2 is superseded.",
        targetLeafEntryId: "leaf-2",
      }),
    ];

    const engine = new ReasoningReplayEngine({
      listEvents: () => events,
    });

    const state = engine.replay(sessionId);

    expect(state.reverts.map((entry) => entry.revertId)).toEqual(["reasoning-revert-1"]);
    expect(state.activeBranchId).toBe(branchedId);
    expect(state.activeCheckpointId).toBe("reasoning-checkpoint-1");
    expect(state.activeLineageCheckpointIds).toEqual(["reasoning-checkpoint-1"]);
    expect(engine.canRevertTo(sessionId, "reasoning-checkpoint-2")).toBe(false);
  });
});

describe("normalizeReasoningContinuityPacket", () => {
  test("accepts a valid string within the byte limit", () => {
    const result = normalizeReasoningContinuityPacket("Keep the surviving branch facts.");
    expect(result.schema).toBe("brewva.reasoning.continuity.v1");
    expect(result.text).toBe("Keep the surviving branch facts.");
  });

  test("accepts a valid packet object within the byte limit", () => {
    const result = normalizeReasoningContinuityPacket({
      schema: "brewva.reasoning.continuity.v1",
      text: "  trimmed text  ",
    });
    expect(result.text).toBe("trimmed text");
  });

  test("rejects empty string input", () => {
    expect(() => normalizeReasoningContinuityPacket("")).toThrow(
      "reasoning continuity text must be non-empty",
    );
  });

  test("rejects whitespace-only string input", () => {
    expect(() => normalizeReasoningContinuityPacket("   ")).toThrow(
      "reasoning continuity text must be non-empty",
    );
  });

  test("rejects text that exceeds the byte limit", () => {
    const oversized = "x".repeat(MAX_REASONING_CONTINUITY_BYTES + 1);
    expect(() => normalizeReasoningContinuityPacket(oversized)).toThrow(
      `reasoning continuity exceeds ${MAX_REASONING_CONTINUITY_BYTES} bytes`,
    );
  });

  test("rejects multibyte text that fits in characters but exceeds the byte limit", () => {
    const cjk = "\u4e00".repeat(MAX_REASONING_CONTINUITY_BYTES);
    expect(Buffer.byteLength(cjk, "utf8")).toBeGreaterThan(MAX_REASONING_CONTINUITY_BYTES);
    expect(() => normalizeReasoningContinuityPacket(cjk)).toThrow(
      `reasoning continuity exceeds ${MAX_REASONING_CONTINUITY_BYTES} bytes`,
    );
  });

  test("accepts text at exactly the byte limit", () => {
    const exact = "a".repeat(MAX_REASONING_CONTINUITY_BYTES);
    const result = normalizeReasoningContinuityPacket(exact);
    expect(result.text).toBe(exact);
  });
});

describe("coerceReasoningContinuityPacket", () => {
  test("returns null for oversized payload", () => {
    expect(
      coerceReasoningContinuityPacket({
        schema: "brewva.reasoning.continuity.v1",
        text: "x".repeat(MAX_REASONING_CONTINUITY_BYTES + 1),
      }),
    ).toBeNull();
  });

  test("returns null for empty text", () => {
    expect(
      coerceReasoningContinuityPacket({
        schema: "brewva.reasoning.continuity.v1",
        text: "",
      }),
    ).toBeNull();
  });

  test("returns null for wrong schema", () => {
    expect(
      coerceReasoningContinuityPacket({
        schema: "wrong.schema",
        text: "valid text",
      }),
    ).toBeNull();
  });
});
