import type { JsonValue } from "../utils/json.js";
import type { BrewvaSessionId } from "./identifiers.js";
import type { RedoResult, RollbackResult } from "./patching.js";
import type { ReasoningCheckpointRecord, ReasoningRevertRecord } from "./reasoning.js";

export type CorrectionCheckpointStatus = "active" | "undone" | "redone" | "superseded";

export interface CorrectionPromptSnapshot {
  text: string;
  parts: JsonValue[];
}

export interface RecordCorrectionCheckpointInput {
  turnId?: string;
  leafEntryId?: string | null;
  prompt?: CorrectionPromptSnapshot;
}

export interface CorrectionCheckpointRecord {
  checkpointId: string;
  sessionId: BrewvaSessionId;
  turnId: string;
  reasoningCheckpointId: string;
  leafEntryId: string | null;
  prompt?: CorrectionPromptSnapshot;
  turn: number;
  eventId: string;
  timestamp: number;
  status: CorrectionCheckpointStatus;
  undoneAt?: number;
  redoneAt?: number;
  supersededAt?: number;
  patchSetIds: string[];
  redoLeafEntryId: string | null;
}

export interface CorrectionUndoInput {
  checkpointId?: string;
  continuity?: string;
  redoLeafEntryId?: string | null;
}

export interface CorrectionRedoInput {
  checkpointId?: string;
  redoLeafEntryId?: string | null;
}

export interface CorrectionUndoRecord {
  eventId: string;
  timestamp: number;
  checkpointId: string;
  reasoningRevert: ReasoningRevertRecord;
  patchSetIds: string[];
  rollbackResults: RollbackResult[];
  redoLeafEntryId: string | null;
}

export interface CorrectionRedoRecord {
  eventId: string;
  timestamp: number;
  checkpointId: string;
  patchSetIds: string[];
  redoResults: RedoResult[];
  redoLeafEntryId: string | null;
  reasoningCheckpoint?: ReasoningCheckpointRecord;
}

export type CorrectionUndoFailureReason =
  | "no_checkpoint"
  | "checkpoint_not_undoable"
  | "rollback_failed"
  | "reasoning_revert_failed";

export type CorrectionRedoFailureReason =
  | "no_undone_checkpoint"
  | "checkpoint_not_redoable"
  | "redo_failed"
  | "reasoning_checkpoint_failed";

export type CorrectionUndoResult =
  | {
      ok: true;
      checkpoint: CorrectionCheckpointRecord;
      reasoningRevert: ReasoningRevertRecord;
      patchSetIds: string[];
      rollbackResults: RollbackResult[];
      restoredPrompt?: CorrectionPromptSnapshot;
      redoLeafEntryId: string | null;
    }
  | {
      ok: false;
      reason: CorrectionUndoFailureReason;
      checkpoint?: CorrectionCheckpointRecord;
      patchSetIds?: string[];
      rollbackResults?: RollbackResult[];
      compensationRedoResults?: RedoResult[];
      error?: string;
    };

export type CorrectionRedoResult =
  | {
      ok: true;
      checkpoint: CorrectionCheckpointRecord;
      patchSetIds: string[];
      redoResults: RedoResult[];
      restoredPrompt?: CorrectionPromptSnapshot;
      redoLeafEntryId: string | null;
      reasoningCheckpoint?: ReasoningCheckpointRecord;
    }
  | {
      ok: false;
      reason: CorrectionRedoFailureReason;
      checkpoint?: CorrectionCheckpointRecord;
      patchSetIds?: string[];
      redoResults?: RedoResult[];
      compensationRollbackResults?: RollbackResult[];
      error?: string;
    };

export interface CorrectionState {
  checkpoints: CorrectionCheckpointRecord[];
  undoAvailable: boolean;
  redoAvailable: boolean;
  latestUndoable?: CorrectionCheckpointRecord;
  nextRedoable?: CorrectionCheckpointRecord;
  latestUndo?: CorrectionUndoRecord;
  latestRedo?: CorrectionRedoRecord;
}
