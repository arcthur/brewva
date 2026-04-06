import type {
  ActiveReasoningBranchState,
  ReasoningCheckpointRecord,
  ReasoningRevertInput,
  ReasoningRevertRecord,
  RecordReasoningCheckpointInput,
} from "../contracts/reasoning.js";
import {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  buildReasoningCheckpointPayload,
  buildReasoningRevertPayload,
} from "../tape/reasoning-events.js";
import type { ReasoningReplayEngine } from "../tape/reasoning-replay.js";
import type { RuntimeCallback } from "./callback.js";

export interface ReasoningServiceOptions {
  replay: ReasoningReplayEngine;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: object;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ]
  >;
}

function buildCheckpointId(sequence: number): string {
  return `reasoning-checkpoint-${sequence}`;
}

function buildBranchId(sessionId: string, sequence: number): string {
  return `${sessionId}:reasoning-branch-${sequence}`;
}

function buildRevertId(sequence: number): string {
  return `reasoning-revert-${sequence}`;
}

function normalizeCheckpointId(input: string): string {
  const normalized = input.trim();
  if (normalized.length === 0) {
    throw new Error("reasoning revert requires a non-empty checkpoint id");
  }
  return normalized;
}

function normalizeLinkedRollbackReceiptIds(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return values
    .map((value) => value.trim())
    .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
}

export class ReasoningService {
  private readonly replay: ReasoningReplayEngine;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: ReasoningServiceOptions["recordEvent"];

  constructor(options: ReasoningServiceOptions) {
    this.replay = options.replay;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
  }

  getActiveState(sessionId: string): ActiveReasoningBranchState {
    return this.replay.getActiveState(sessionId);
  }

  listCheckpoints(sessionId: string): ReasoningCheckpointRecord[] {
    return this.replay.listCheckpoints(sessionId);
  }

  getCheckpoint(sessionId: string, checkpointId: string): ReasoningCheckpointRecord | undefined {
    return this.replay.getCheckpoint(sessionId, checkpointId);
  }

  listReverts(sessionId: string): ReasoningRevertRecord[] {
    return this.replay.listReverts(sessionId);
  }

  canRevertTo(sessionId: string, checkpointId: string): boolean {
    return this.replay.canRevertTo(sessionId, checkpointId);
  }

  recordCheckpoint(
    sessionId: string,
    input: RecordReasoningCheckpointInput,
  ): ReasoningCheckpointRecord {
    const state = this.replay.getActiveState(sessionId);
    const checkpointSequence = state.nextCheckpointSequence;
    const checkpointId = buildCheckpointId(checkpointSequence);
    const payload = buildReasoningCheckpointPayload({
      checkpointId,
      checkpointSequence,
      branchId: state.activeBranchId,
      branchSequence: state.activeBranchSequence,
      parentCheckpointId: state.activeCheckpointId,
      boundary: input.boundary,
      leafEntryId: input.leafEntryId ?? null,
    });
    this.recordEvent({
      sessionId,
      turn: this.getCurrentTurn(sessionId),
      type: REASONING_CHECKPOINT_EVENT_TYPE,
      payload,
      skipTapeCheckpoint: true,
    });
    const recorded = this.replay.getCheckpoint(sessionId, checkpointId);
    if (!recorded) {
      throw new Error(`failed to materialize reasoning checkpoint ${checkpointId}`);
    }
    return recorded;
  }

  revert(sessionId: string, input: ReasoningRevertInput): ReasoningRevertRecord {
    const state = this.replay.getActiveState(sessionId);
    const toCheckpointId = normalizeCheckpointId(input.toCheckpointId);
    const targetCheckpoint = state.checkpoints.find(
      (entry) => entry.checkpointId === toCheckpointId,
    );
    if (!targetCheckpoint) {
      throw new Error(`unknown reasoning checkpoint: ${toCheckpointId}`);
    }
    if (!state.activeLineageCheckpointIds.includes(toCheckpointId)) {
      throw new Error(
        `checkpoint ${toCheckpointId} does not belong to the current active reasoning lineage`,
      );
    }
    const revertSequence = state.nextRevertSequence;
    const newBranchSequence = state.nextBranchSequence;
    const revertId = buildRevertId(revertSequence);
    const payload = buildReasoningRevertPayload({
      revertId,
      revertSequence,
      toCheckpointId,
      fromCheckpointId: state.activeCheckpointId,
      fromBranchId: state.activeBranchId,
      newBranchId: buildBranchId(sessionId, newBranchSequence),
      newBranchSequence,
      trigger: input.trigger,
      continuityPacket: input.continuity,
      linkedRollbackReceiptIds: normalizeLinkedRollbackReceiptIds(input.linkedRollbackReceiptIds),
      targetLeafEntryId: targetCheckpoint.leafEntryId,
    });
    this.recordEvent({
      sessionId,
      turn: this.getCurrentTurn(sessionId),
      type: REASONING_REVERT_EVENT_TYPE,
      payload,
      skipTapeCheckpoint: true,
    });
    const recorded = this.replay
      .listReverts(sessionId)
      .find((entry) => entry.revertId === revertId);
    if (!recorded) {
      throw new Error(`failed to materialize reasoning revert ${revertId}`);
    }
    return recorded;
  }
}
