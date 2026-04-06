import type { BrewvaEventRecord } from "../contracts/index.js";
import type {
  ActiveReasoningBranchState,
  ReasoningCheckpointRecord,
  ReasoningContinuityPacket,
  ReasoningRevertRecord,
} from "../contracts/reasoning.js";
import {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
  coerceReasoningCheckpointPayload,
  coerceReasoningRevertPayload,
} from "./reasoning-events.js";

interface ReasoningReplayEngineOptions {
  listEvents: (sessionId: string) => BrewvaEventRecord[];
}

interface InternalReasoningBranchState extends ActiveReasoningBranchState {
  checkpointById: Map<string, ReasoningCheckpointRecord>;
}

function buildRootBranchId(sessionId: string): string {
  return `${sessionId}:reasoning-branch-0`;
}

function cloneContinuityPacket(
  packet: ReasoningContinuityPacket | undefined,
): ReasoningContinuityPacket | undefined {
  return packet
    ? {
        schema: packet.schema,
        text: packet.text,
      }
    : undefined;
}

function normalizeTurn(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cloneCheckpointRecord(record: ReasoningCheckpointRecord): ReasoningCheckpointRecord {
  return { ...record };
}

function cloneRevertRecord(record: ReasoningRevertRecord): ReasoningRevertRecord {
  return {
    ...record,
    continuityPacket: {
      schema: record.continuityPacket.schema,
      text: record.continuityPacket.text,
    },
    linkedRollbackReceiptIds: [...record.linkedRollbackReceiptIds],
  };
}

function normalizeOptionalId(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasRecordedBranchId(state: InternalReasoningBranchState, branchId: string): boolean {
  if (state.rootBranchId === branchId) {
    return true;
  }
  return (
    state.checkpoints.some((record) => record.branchId === branchId) ||
    state.reverts.some((record) => record.newBranchId === branchId)
  );
}

function createEmptyState(sessionId: string): InternalReasoningBranchState {
  return {
    sessionId,
    rootBranchId: buildRootBranchId(sessionId),
    activeBranchId: buildRootBranchId(sessionId),
    activeBranchSequence: 0,
    activeCheckpointId: null,
    activeLineageCheckpointIds: [],
    checkpoints: [],
    reverts: [],
    nextCheckpointSequence: 1,
    nextBranchSequence: 1,
    nextRevertSequence: 1,
    checkpointById: new Map<string, ReasoningCheckpointRecord>(),
  };
}

function finalizeState(state: InternalReasoningBranchState): InternalReasoningBranchState {
  const activeCheckpoint = state.activeCheckpointId
    ? state.checkpointById.get(state.activeCheckpointId)
    : undefined;
  const activeLineageCheckpointIds: string[] = [];
  let cursor = activeCheckpoint;
  while (cursor) {
    activeLineageCheckpointIds.push(cursor.checkpointId);
    cursor = cursor.parentCheckpointId
      ? state.checkpointById.get(cursor.parentCheckpointId)
      : undefined;
  }
  activeLineageCheckpointIds.reverse();
  return {
    ...state,
    activeCheckpoint,
    activeLineageCheckpointIds,
  };
}

function cloneState(state: InternalReasoningBranchState): ActiveReasoningBranchState {
  return {
    sessionId: state.sessionId,
    rootBranchId: state.rootBranchId,
    activeBranchId: state.activeBranchId,
    activeBranchSequence: state.activeBranchSequence,
    activeCheckpointId: state.activeCheckpointId,
    ...(state.activeCheckpoint
      ? { activeCheckpoint: cloneCheckpointRecord(state.activeCheckpoint) }
      : {}),
    activeLineageCheckpointIds: [...state.activeLineageCheckpointIds],
    ...(state.latestRevert ? { latestRevert: cloneRevertRecord(state.latestRevert) } : {}),
    ...(state.latestContinuityPacket
      ? { latestContinuityPacket: cloneContinuityPacket(state.latestContinuityPacket) }
      : {}),
    checkpoints: state.checkpoints.map((record) => cloneCheckpointRecord(record)),
    reverts: state.reverts.map((record) => cloneRevertRecord(record)),
    nextCheckpointSequence: state.nextCheckpointSequence,
    nextBranchSequence: state.nextBranchSequence,
    nextRevertSequence: state.nextRevertSequence,
  };
}

function applyCheckpointEvent(
  previous: InternalReasoningBranchState,
  event: BrewvaEventRecord,
): InternalReasoningBranchState {
  const payload = coerceReasoningCheckpointPayload(event.payload);
  if (!payload) {
    return previous;
  }
  const parentCheckpointId = normalizeOptionalId(payload.parentCheckpointId);
  if (
    previous.checkpointById.has(payload.checkpointId) ||
    payload.checkpointSequence < previous.nextCheckpointSequence ||
    payload.branchId !== previous.activeBranchId ||
    payload.branchSequence !== previous.activeBranchSequence ||
    parentCheckpointId !== previous.activeCheckpointId
  ) {
    return previous;
  }
  const checkpoint: ReasoningCheckpointRecord = {
    checkpointId: payload.checkpointId,
    checkpointSequence: payload.checkpointSequence,
    branchId: payload.branchId,
    branchSequence: payload.branchSequence,
    parentCheckpointId,
    boundary: payload.boundary,
    leafEntryId: payload.leafEntryId ?? null,
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
  };
  const checkpointById = new Map(previous.checkpointById);
  checkpointById.set(checkpoint.checkpointId, checkpoint);
  return finalizeState({
    ...previous,
    activeBranchId: checkpoint.branchId,
    activeBranchSequence: checkpoint.branchSequence,
    activeCheckpointId: checkpoint.checkpointId,
    checkpoints: [...previous.checkpoints, checkpoint],
    checkpointById,
    nextCheckpointSequence: Math.max(
      previous.nextCheckpointSequence,
      checkpoint.checkpointSequence + 1,
    ),
    nextBranchSequence: Math.max(previous.nextBranchSequence, checkpoint.branchSequence + 1),
  });
}

function applyRevertEvent(
  previous: InternalReasoningBranchState,
  event: BrewvaEventRecord,
): InternalReasoningBranchState {
  const payload = coerceReasoningRevertPayload(event.payload);
  if (!payload) {
    return previous;
  }
  const fromCheckpointId = normalizeOptionalId(payload.fromCheckpointId);
  const targetCheckpoint = previous.checkpointById.get(payload.toCheckpointId);
  if (
    !targetCheckpoint ||
    previous.reverts.some((record) => record.revertId === payload.revertId) ||
    payload.revertSequence < previous.nextRevertSequence ||
    payload.newBranchSequence < previous.nextBranchSequence ||
    payload.fromBranchId !== previous.activeBranchId ||
    fromCheckpointId !== previous.activeCheckpointId ||
    !previous.activeLineageCheckpointIds.includes(payload.toCheckpointId) ||
    hasRecordedBranchId(previous, payload.newBranchId)
  ) {
    return previous;
  }
  const revert: ReasoningRevertRecord = {
    revertId: payload.revertId,
    revertSequence: payload.revertSequence,
    toCheckpointId: payload.toCheckpointId,
    fromCheckpointId,
    fromBranchId: payload.fromBranchId,
    newBranchId: payload.newBranchId,
    newBranchSequence: payload.newBranchSequence,
    trigger: payload.trigger,
    continuityPacket: {
      schema: payload.continuityPacket.schema,
      text: payload.continuityPacket.text,
    },
    linkedRollbackReceiptIds: [...(payload.linkedRollbackReceiptIds ?? [])],
    targetLeafEntryId: payload.targetLeafEntryId ?? targetCheckpoint.leafEntryId,
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
  };
  return finalizeState({
    ...previous,
    activeBranchId: revert.newBranchId,
    activeBranchSequence: revert.newBranchSequence,
    activeCheckpointId: revert.toCheckpointId,
    latestRevert: revert,
    latestContinuityPacket: cloneContinuityPacket(revert.continuityPacket),
    reverts: [...previous.reverts, revert],
    nextBranchSequence: Math.max(previous.nextBranchSequence, revert.newBranchSequence + 1),
    nextRevertSequence: Math.max(previous.nextRevertSequence, revert.revertSequence + 1),
  });
}

export class ReasoningReplayEngine {
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly stateBySession = new Map<string, InternalReasoningBranchState>();

  constructor(options: ReasoningReplayEngineOptions) {
    this.listEvents = options.listEvents;
  }

  replay(sessionId: string): ActiveReasoningBranchState {
    const cached = this.stateBySession.get(sessionId);
    if (cached) {
      return cloneState(cached);
    }
    const built = this.buildState(sessionId, this.listEvents(sessionId));
    this.stateBySession.set(sessionId, built);
    return cloneState(built);
  }

  observeEvent(event: BrewvaEventRecord): void {
    const cached = this.stateBySession.get(event.sessionId);
    if (!cached) {
      return;
    }
    if (event.type === REASONING_CHECKPOINT_EVENT_TYPE) {
      this.stateBySession.set(event.sessionId, applyCheckpointEvent(cached, event));
      return;
    }
    if (event.type === REASONING_REVERT_EVENT_TYPE) {
      this.stateBySession.set(event.sessionId, applyRevertEvent(cached, event));
    }
  }

  getActiveState(sessionId: string): ActiveReasoningBranchState {
    return this.replay(sessionId);
  }

  listCheckpoints(sessionId: string): ReasoningCheckpointRecord[] {
    return this.replay(sessionId).checkpoints;
  }

  getCheckpoint(sessionId: string, checkpointId: string): ReasoningCheckpointRecord | undefined {
    return this.replay(sessionId).checkpoints.find((entry) => entry.checkpointId === checkpointId);
  }

  listReverts(sessionId: string): ReasoningRevertRecord[] {
    return this.replay(sessionId).reverts;
  }

  canRevertTo(sessionId: string, checkpointId: string): boolean {
    return this.replay(sessionId).activeLineageCheckpointIds.includes(checkpointId);
  }

  invalidate(sessionId: string): void {
    this.stateBySession.delete(sessionId);
  }

  clear(sessionId: string): void {
    this.invalidate(sessionId);
  }

  private buildState(sessionId: string, events: BrewvaEventRecord[]): InternalReasoningBranchState {
    let state = createEmptyState(sessionId);
    for (const event of events) {
      if (event.type === REASONING_CHECKPOINT_EVENT_TYPE) {
        state = applyCheckpointEvent(state, event);
      } else if (event.type === REASONING_REVERT_EVENT_TYPE) {
        state = applyRevertEvent(state, event);
      }
    }
    return finalizeState(state);
  }
}
