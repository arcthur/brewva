import type {
  BrewvaEventRecord,
  CorrectionCheckpointRecord,
  CorrectionPromptSnapshot,
  CorrectionRedoFailureReason,
  CorrectionRedoInput,
  CorrectionRedoRecord,
  CorrectionRedoResult,
  CorrectionState,
  CorrectionUndoFailureReason,
  CorrectionUndoInput,
  CorrectionUndoRecord,
  CorrectionUndoResult,
  RecordCorrectionCheckpointInput,
  RedoResult,
  RollbackResult,
} from "../contracts/index.js";
import { REASONING_CONTINUITY_SCHEMA, asBrewvaSessionId } from "../contracts/index.js";
import {
  CORRECTION_CHECKPOINT_RECORDED_EVENT_TYPE,
  CORRECTION_REDO_COMPLETED_EVENT_TYPE,
  CORRECTION_UNDO_COMPLETED_EVENT_TYPE,
  CORRECTION_WINDOW_SUPERSEDED_EVENT_TYPE,
  PATCH_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import type { BrewvaEventStore } from "../events/store.js";
import type { JsonValue } from "../utils/json.js";
import type { FileChangeService } from "./file-change.js";
import type { ReasoningService } from "./reasoning.js";

const CORRECTION_CHECKPOINT_SCHEMA = "brewva.correction.checkpoint.v1";
const CORRECTION_UNDO_SCHEMA = "brewva.correction.undo.v1";
const CORRECTION_REDO_SCHEMA = "brewva.correction.redo.v1";
const CORRECTION_SUPERSEDE_SCHEMA = "brewva.correction.supersede.v1";

export interface CorrectionServiceOptions {
  eventStore: BrewvaEventStore;
  reasoningService: Pick<ReasoningService, "recordCheckpoint" | "revert">;
  fileChangeService: Pick<FileChangeService, "rollbackPatchSet" | "redoPatchSet">;
  getCurrentTurn(sessionId: string): number;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): BrewvaEventRecord | undefined;
}

interface InternalCorrectionState {
  checkpoints: CorrectionCheckpointRecord[];
  byId: Map<string, CorrectionCheckpointRecord>;
  latestUndo?: CorrectionUndoRecord;
  latestRedo?: CorrectionRedoRecord;
}

function buildCorrectionCheckpointId(sequence: number): string {
  return `correction-checkpoint-${sequence}`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return normalizeOptionalString(value) ?? null;
}

function normalizeTurn(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizePromptSnapshot(value: unknown): CorrectionPromptSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") {
    return undefined;
  }
  const parts = Array.isArray(record.parts) ? (record.parts as JsonValue[]) : [];
  return {
    text: record.text,
    parts: structuredClone(parts),
  };
}

function clonePromptSnapshot(
  value: CorrectionPromptSnapshot | undefined,
): CorrectionPromptSnapshot | undefined {
  return value
    ? {
        text: value.text,
        parts: structuredClone(value.parts),
      }
    : undefined;
}

function cloneCheckpoint(record: CorrectionCheckpointRecord): CorrectionCheckpointRecord {
  return {
    ...record,
    ...(record.prompt ? { prompt: clonePromptSnapshot(record.prompt) } : {}),
    patchSetIds: [...record.patchSetIds],
  };
}

function cloneUndoRecord(record: CorrectionUndoRecord): CorrectionUndoRecord {
  return {
    ...record,
    reasoningRevert: structuredClone(record.reasoningRevert),
    patchSetIds: [...record.patchSetIds],
    rollbackResults: structuredClone(record.rollbackResults),
  };
}

function cloneRedoRecord(record: CorrectionRedoRecord): CorrectionRedoRecord {
  return {
    ...record,
    patchSetIds: [...record.patchSetIds],
    redoResults: structuredClone(record.redoResults),
    ...(record.reasoningCheckpoint
      ? { reasoningCheckpoint: structuredClone(record.reasoningCheckpoint) }
      : {}),
  };
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRollbackMutationReceiptId(result: RollbackResult): string | undefined {
  return typeof result.mutationReceiptId === "string" && result.mutationReceiptId.trim().length > 0
    ? result.mutationReceiptId.trim()
    : undefined;
}

function readPatchSetIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function readRollbackResults(value: unknown): RollbackResult[] {
  return Array.isArray(value) ? (structuredClone(value) as RollbackResult[]) : [];
}

function readRedoResults(value: unknown): RedoResult[] {
  return Array.isArray(value) ? (structuredClone(value) as RedoResult[]) : [];
}

function isUndoableCheckpoint(record: CorrectionCheckpointRecord): boolean {
  return record.status === "active" || record.status === "redone";
}

function isRedoableCheckpoint(record: CorrectionCheckpointRecord): boolean {
  return record.status === "undone";
}

function buildDefaultContinuity(checkpoint: CorrectionCheckpointRecord): string {
  const prompt = checkpoint.prompt?.text.trim();
  return prompt
    ? `Operator correction undo restored the session before this prompt: ${prompt.slice(0, 900)}`
    : "Operator correction undo restored the session to the selected checkpoint.";
}

function readCheckpointPayload(event: BrewvaEventRecord): CorrectionCheckpointRecord | undefined {
  const payload = event.payload;
  const checkpointId = normalizeOptionalString(payload?.checkpointId);
  const turnId = normalizeOptionalString(payload?.turnId);
  const reasoningCheckpointId = normalizeOptionalString(payload?.reasoningCheckpointId);
  if (!checkpointId || !turnId || !reasoningCheckpointId) {
    return undefined;
  }
  return {
    checkpointId,
    sessionId: asBrewvaSessionId(event.sessionId),
    turnId,
    reasoningCheckpointId,
    leafEntryId: normalizeNullableString(payload?.leafEntryId),
    prompt: normalizePromptSnapshot(payload?.prompt),
    turn: normalizeTurn(event.turn),
    eventId: event.id,
    timestamp: event.timestamp,
    status: "active",
    patchSetIds: [],
    redoLeafEntryId: null,
  };
}

function readCorrectionUndoPayload(event: BrewvaEventRecord): CorrectionUndoRecord | undefined {
  const payload = event.payload;
  if (payload?.ok !== true) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(payload.checkpointId);
  const reasoningRevert =
    payload.reasoningRevert && typeof payload.reasoningRevert === "object"
      ? structuredClone(payload.reasoningRevert)
      : undefined;
  if (!checkpointId || !reasoningRevert) {
    return undefined;
  }
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    checkpointId,
    reasoningRevert: reasoningRevert as unknown as CorrectionUndoRecord["reasoningRevert"],
    patchSetIds: readPatchSetIds(payload.patchSetIds),
    rollbackResults: readRollbackResults(payload.rollbackResults),
    redoLeafEntryId: normalizeNullableString(payload.redoLeafEntryId),
  };
}

function readCorrectionRedoPayload(event: BrewvaEventRecord): CorrectionRedoRecord | undefined {
  const payload = event.payload;
  if (payload?.ok !== true) {
    return undefined;
  }
  const checkpointId = normalizeOptionalString(payload.checkpointId);
  if (!checkpointId) {
    return undefined;
  }
  const reasoningCheckpoint =
    payload.reasoningCheckpoint && typeof payload.reasoningCheckpoint === "object"
      ? structuredClone(payload.reasoningCheckpoint)
      : undefined;
  return {
    eventId: event.id,
    timestamp: event.timestamp,
    checkpointId,
    patchSetIds: readPatchSetIds(payload.patchSetIds),
    redoResults: readRedoResults(payload.redoResults),
    redoLeafEntryId: normalizeNullableString(payload.redoLeafEntryId),
    ...(reasoningCheckpoint
      ? {
          reasoningCheckpoint: reasoningCheckpoint as unknown as NonNullable<
            CorrectionRedoRecord["reasoningCheckpoint"]
          >,
        }
      : {}),
  };
}

export class CorrectionService {
  private readonly eventStore: BrewvaEventStore;
  private readonly reasoningService: CorrectionServiceOptions["reasoningService"];
  private readonly fileChangeService: CorrectionServiceOptions["fileChangeService"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: CorrectionServiceOptions["recordEvent"];

  constructor(options: CorrectionServiceOptions) {
    this.eventStore = options.eventStore;
    this.reasoningService = options.reasoningService;
    this.fileChangeService = options.fileChangeService;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  recordCheckpoint(
    sessionId: string,
    input: RecordCorrectionCheckpointInput = {},
  ): CorrectionCheckpointRecord {
    const currentState = this.buildInternalState(sessionId);
    const supersededCheckpointIds = currentState.checkpoints
      .filter((checkpoint) => checkpoint.status === "undone")
      .map((checkpoint) => checkpoint.checkpointId);
    if (supersededCheckpointIds.length > 0) {
      const superseded = this.recordEvent({
        sessionId,
        type: CORRECTION_WINDOW_SUPERSEDED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          schema: CORRECTION_SUPERSEDE_SCHEMA,
          checkpointIds: supersededCheckpointIds,
        },
      });
      if (!superseded) {
        throw new Error(
          `failed to supersede correction checkpoint(s) ${supersededCheckpointIds.join(",")}`,
        );
      }
    }

    const reasoningCheckpoint = this.reasoningService.recordCheckpoint(sessionId, {
      boundary: "operator_marker",
      leafEntryId: input.leafEntryId ?? null,
    });
    const sequence = currentState.checkpoints.length + 1;
    const checkpointId = buildCorrectionCheckpointId(sequence);
    const turn = this.getCurrentTurn(sessionId);
    const turnId = input.turnId?.trim() || `correction-turn-${turn}-${sequence}`;
    const prompt = clonePromptSnapshot(input.prompt);
    const recorded = this.recordEvent({
      sessionId,
      type: CORRECTION_CHECKPOINT_RECORDED_EVENT_TYPE,
      turn,
      payload: {
        schema: CORRECTION_CHECKPOINT_SCHEMA,
        checkpointId,
        turnId,
        reasoningCheckpointId: reasoningCheckpoint.checkpointId,
        leafEntryId: reasoningCheckpoint.leafEntryId,
        prompt: prompt ?? null,
      },
    });
    if (!recorded) {
      throw new Error(`failed to record correction checkpoint ${checkpointId}`);
    }
    return {
      checkpointId,
      sessionId: asBrewvaSessionId(sessionId),
      turnId,
      reasoningCheckpointId: reasoningCheckpoint.checkpointId,
      leafEntryId: reasoningCheckpoint.leafEntryId,
      ...(prompt ? { prompt } : {}),
      turn: normalizeTurn(recorded.turn),
      eventId: recorded.id,
      timestamp: recorded.timestamp,
      status: "active",
      patchSetIds: [],
      redoLeafEntryId: null,
    };
  }

  undo(sessionId: string, input: CorrectionUndoInput = {}): CorrectionUndoResult {
    const state = this.getState(sessionId);
    const target = this.resolveUndoCheckpoint(state, input.checkpointId);
    if (!target) {
      return {
        ok: false,
        reason: state.checkpoints.length === 0 ? "no_checkpoint" : "checkpoint_not_undoable",
      };
    }

    const patchSetIds = this.listPatchSetIdsAfterCheckpoint(sessionId, target);
    const rollbackResults: RollbackResult[] = [];
    const rolledBackPatchSetIds: string[] = [];
    for (const patchSetId of patchSetIds.toReversed()) {
      const rollback = this.fileChangeService.rollbackPatchSet(sessionId, patchSetId);
      rollbackResults.push(rollback);
      if (!rollback.ok) {
        const compensationRedoResults = this.compensateRolledBackPatchSets(
          sessionId,
          rolledBackPatchSetIds,
        );
        this.recordCorrectionUndoFailure(sessionId, target, patchSetIds, rollbackResults, {
          reason: "rollback_failed",
          error: rollback.reason,
          compensationRedoResults,
        });
        return {
          ok: false,
          reason: "rollback_failed",
          checkpoint: target,
          patchSetIds,
          rollbackResults,
          compensationRedoResults,
          error: rollback.reason,
        };
      }
      rolledBackPatchSetIds.push(patchSetId);
    }

    try {
      const reasoningRevert = this.reasoningService.revert(sessionId, {
        toCheckpointId: target.reasoningCheckpointId,
        trigger: "operator_request",
        continuity: {
          schema: REASONING_CONTINUITY_SCHEMA,
          text: input.continuity?.trim() || buildDefaultContinuity(target),
        },
        linkedRollbackReceiptIds: rollbackResults
          .map((result) => normalizeRollbackMutationReceiptId(result))
          .filter((value): value is string => typeof value === "string"),
      });
      const redoLeafEntryId = input.redoLeafEntryId ?? null;
      const recorded = this.recordEvent({
        sessionId,
        type: CORRECTION_UNDO_COMPLETED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          schema: CORRECTION_UNDO_SCHEMA,
          ok: true,
          checkpointId: target.checkpointId,
          reasoningRevert,
          patchSetIds,
          rollbackResults,
          redoLeafEntryId,
        },
      });
      if (!recorded) {
        throw new Error(`failed to record correction undo for ${target.checkpointId}`);
      }
      return {
        ok: true,
        checkpoint: {
          ...target,
          status: "undone",
          undoneAt: recorded.timestamp,
          patchSetIds,
          redoLeafEntryId,
        },
        reasoningRevert,
        patchSetIds,
        rollbackResults,
        restoredPrompt: clonePromptSnapshot(target.prompt),
        redoLeafEntryId,
      };
    } catch (error) {
      const message = normalizeError(error);
      const compensationRedoResults = this.compensateRolledBackPatchSets(
        sessionId,
        rolledBackPatchSetIds,
      );
      this.recordCorrectionUndoFailure(sessionId, target, patchSetIds, rollbackResults, {
        reason: "reasoning_revert_failed",
        error: message,
        compensationRedoResults,
      });
      return {
        ok: false,
        reason: "reasoning_revert_failed",
        checkpoint: target,
        patchSetIds,
        rollbackResults,
        compensationRedoResults,
        error: message,
      };
    }
  }

  redo(sessionId: string, input: CorrectionRedoInput = {}): CorrectionRedoResult {
    const state = this.getState(sessionId);
    const target = this.resolveRedoCheckpoint(state, input.checkpointId);
    if (!target) {
      return {
        ok: false,
        reason:
          state.checkpoints.some((checkpoint) => checkpoint.status === "undone") ||
          input.checkpointId
            ? "checkpoint_not_redoable"
            : "no_undone_checkpoint",
      };
    }

    const patchSetIds =
      target.patchSetIds.length > 0
        ? target.patchSetIds
        : this.listPatchSetIdsAfterCheckpoint(sessionId, target);
    const redoResults: RedoResult[] = [];
    const redonePatchSetIds: string[] = [];
    for (const patchSetId of patchSetIds) {
      const redo = this.fileChangeService.redoPatchSet(sessionId, patchSetId);
      redoResults.push(redo);
      if (!redo.ok) {
        const compensationRollbackResults = this.compensateRedonePatchSets(
          sessionId,
          redonePatchSetIds,
        );
        this.recordCorrectionRedoFailure(sessionId, target, patchSetIds, redoResults, {
          reason: "redo_failed",
          error: redo.reason,
          compensationRollbackResults,
        });
        return {
          ok: false,
          reason: "redo_failed",
          checkpoint: target,
          patchSetIds,
          redoResults,
          compensationRollbackResults,
          error: redo.reason,
        };
      }
      redonePatchSetIds.push(patchSetId);
    }

    const redoLeafEntryId = input.redoLeafEntryId ?? target.redoLeafEntryId;
    try {
      const reasoningCheckpoint = this.reasoningService.recordCheckpoint(sessionId, {
        boundary: "operator_marker",
        leafEntryId: redoLeafEntryId,
      });
      const recorded = this.recordEvent({
        sessionId,
        type: CORRECTION_REDO_COMPLETED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          schema: CORRECTION_REDO_SCHEMA,
          ok: true,
          checkpointId: target.checkpointId,
          patchSetIds,
          redoResults,
          redoLeafEntryId,
          reasoningCheckpoint,
        },
      });
      if (!recorded) {
        throw new Error(`failed to record correction redo for ${target.checkpointId}`);
      }
      return {
        ok: true,
        checkpoint: {
          ...target,
          status: "redone",
          redoneAt: recorded.timestamp,
          patchSetIds,
          redoLeafEntryId,
        },
        patchSetIds,
        redoResults,
        restoredPrompt: clonePromptSnapshot(target.prompt),
        redoLeafEntryId,
        reasoningCheckpoint,
      };
    } catch (error) {
      const message = normalizeError(error);
      const compensationRollbackResults = this.compensateRedonePatchSets(
        sessionId,
        redonePatchSetIds,
      );
      this.recordCorrectionRedoFailure(sessionId, target, patchSetIds, redoResults, {
        reason: "reasoning_checkpoint_failed",
        error: message,
        compensationRollbackResults,
      });
      return {
        ok: false,
        reason: "reasoning_checkpoint_failed",
        checkpoint: target,
        patchSetIds,
        redoResults,
        compensationRollbackResults,
        error: message,
      };
    }
  }

  getState(sessionId: string): CorrectionState {
    const state = this.buildInternalState(sessionId);
    const latestUndoable = state.checkpoints.toReversed().find(isUndoableCheckpoint);
    const nextRedoable = state.checkpoints.find(isRedoableCheckpoint);
    return {
      checkpoints: state.checkpoints.map((checkpoint) => cloneCheckpoint(checkpoint)),
      undoAvailable: Boolean(latestUndoable),
      redoAvailable: Boolean(nextRedoable),
      ...(latestUndoable ? { latestUndoable: cloneCheckpoint(latestUndoable) } : {}),
      ...(nextRedoable ? { nextRedoable: cloneCheckpoint(nextRedoable) } : {}),
      ...(state.latestUndo ? { latestUndo: cloneUndoRecord(state.latestUndo) } : {}),
      ...(state.latestRedo ? { latestRedo: cloneRedoRecord(state.latestRedo) } : {}),
    };
  }

  private resolveUndoCheckpoint(
    state: CorrectionState,
    checkpointId: string | undefined,
  ): CorrectionCheckpointRecord | undefined {
    const latest = state.latestUndoable;
    const normalized = checkpointId?.trim();
    if (!normalized) {
      return latest;
    }
    if (!latest || latest.checkpointId !== normalized) {
      return undefined;
    }
    return latest;
  }

  private resolveRedoCheckpoint(
    state: CorrectionState,
    checkpointId: string | undefined,
  ): CorrectionCheckpointRecord | undefined {
    const next = state.nextRedoable;
    const normalized = checkpointId?.trim();
    if (!normalized) {
      return next;
    }
    if (!next || next.checkpointId !== normalized) {
      return undefined;
    }
    return next;
  }

  private buildInternalState(sessionId: string): InternalCorrectionState {
    const state: InternalCorrectionState = {
      checkpoints: [],
      byId: new Map(),
    };
    for (const event of this.eventStore.list(sessionId)) {
      if (event.type === CORRECTION_CHECKPOINT_RECORDED_EVENT_TYPE) {
        const checkpoint = readCheckpointPayload(event);
        if (!checkpoint || state.byId.has(checkpoint.checkpointId)) {
          continue;
        }
        state.byId.set(checkpoint.checkpointId, checkpoint);
        state.checkpoints.push(checkpoint);
        continue;
      }

      if (event.type === CORRECTION_UNDO_COMPLETED_EVENT_TYPE) {
        const undo = readCorrectionUndoPayload(event);
        if (!undo) {
          continue;
        }
        const checkpoint = state.byId.get(undo.checkpointId);
        if (!checkpoint) {
          continue;
        }
        checkpoint.status = "undone";
        checkpoint.undoneAt = event.timestamp;
        checkpoint.redoneAt = undefined;
        checkpoint.patchSetIds = [...undo.patchSetIds];
        checkpoint.redoLeafEntryId = undo.redoLeafEntryId;
        state.latestUndo = undo;
        continue;
      }

      if (event.type === CORRECTION_REDO_COMPLETED_EVENT_TYPE) {
        const redo = readCorrectionRedoPayload(event);
        if (!redo) {
          continue;
        }
        const checkpoint = state.byId.get(redo.checkpointId);
        if (!checkpoint) {
          continue;
        }
        checkpoint.status = "redone";
        checkpoint.redoneAt = event.timestamp;
        checkpoint.patchSetIds = [...redo.patchSetIds];
        checkpoint.redoLeafEntryId = redo.redoLeafEntryId;
        state.latestRedo = redo;
        continue;
      }

      if (event.type === CORRECTION_WINDOW_SUPERSEDED_EVENT_TYPE) {
        const checkpointIds = readPatchSetIds(event.payload?.checkpointIds);
        for (const checkpointId of checkpointIds) {
          const checkpoint = state.byId.get(checkpointId);
          if (!checkpoint || checkpoint.status !== "undone") {
            continue;
          }
          checkpoint.status = "superseded";
          checkpoint.supersededAt = event.timestamp;
        }
      }
    }
    return state;
  }

  private listPatchSetIdsAfterCheckpoint(
    sessionId: string,
    checkpoint: CorrectionCheckpointRecord,
  ): string[] {
    const events = this.eventStore.list(sessionId);
    const checkpointIndex = events.findIndex((event) => event.id === checkpoint.eventId);
    const candidates =
      checkpointIndex >= 0
        ? events.slice(checkpointIndex + 1)
        : events.filter((event) => event.timestamp >= checkpoint.timestamp);
    const seen = new Set<string>();
    const patchSetIds: string[] = [];
    for (const event of candidates) {
      if (event.type !== PATCH_RECORDED_EVENT_TYPE) {
        continue;
      }
      const patchSetId = normalizeOptionalString(event.payload?.patchSetId);
      if (!patchSetId || seen.has(patchSetId)) {
        continue;
      }
      if (event.payload?.applyStatus === "failed") {
        continue;
      }
      seen.add(patchSetId);
      patchSetIds.push(patchSetId);
    }
    return patchSetIds;
  }

  private compensateRolledBackPatchSets(
    sessionId: string,
    rolledBackPatchSetIds: readonly string[],
  ): RedoResult[] {
    return rolledBackPatchSetIds
      .toReversed()
      .map((patchSetId) => this.fileChangeService.redoPatchSet(sessionId, patchSetId));
  }

  private compensateRedonePatchSets(
    sessionId: string,
    redonePatchSetIds: readonly string[],
  ): RollbackResult[] {
    return redonePatchSetIds
      .toReversed()
      .map((patchSetId) => this.fileChangeService.rollbackPatchSet(sessionId, patchSetId));
  }

  private recordCorrectionUndoFailure(
    sessionId: string,
    checkpoint: CorrectionCheckpointRecord,
    patchSetIds: string[],
    rollbackResults: RollbackResult[],
    input: {
      reason: CorrectionUndoFailureReason;
      error?: string;
      compensationRedoResults?: RedoResult[];
    },
  ): void {
    this.recordEvent({
      sessionId,
      type: CORRECTION_UNDO_COMPLETED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: CORRECTION_UNDO_SCHEMA,
        ok: false,
        checkpointId: checkpoint.checkpointId,
        patchSetIds,
        rollbackResults,
        compensationRedoResults: input.compensationRedoResults ?? [],
        reason: input.reason,
        error: input.error ?? null,
      },
    });
  }

  private recordCorrectionRedoFailure(
    sessionId: string,
    checkpoint: CorrectionCheckpointRecord,
    patchSetIds: string[],
    redoResults: RedoResult[],
    input: {
      reason: CorrectionRedoFailureReason;
      error?: string;
      compensationRollbackResults?: RollbackResult[];
    },
  ): void {
    this.recordEvent({
      sessionId,
      type: CORRECTION_REDO_COMPLETED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: CORRECTION_REDO_SCHEMA,
        ok: false,
        checkpointId: checkpoint.checkpointId,
        patchSetIds,
        redoResults,
        compensationRollbackResults: input.compensationRollbackResults ?? [],
        reason: input.reason,
        error: input.error ?? null,
      },
    });
  }
}
