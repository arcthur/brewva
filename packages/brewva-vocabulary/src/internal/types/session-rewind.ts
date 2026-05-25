import type { JsonValue, ProtocolRecord } from "./foundation.js";
import type { RedoResult, RollbackResult } from "./patch.js";

export type SessionRewindMode = "conversation" | "code" | "both";
export type SessionRewindSummary = "none" | "carry";
export type SessionRewindTrigger = "undo" | "rewind";

export const SESSION_REWIND_CHECKPOINT_SCHEMA = "brewva.session.rewind.checkpoint.v1" as const;
export const SESSION_REWIND_SCHEMA = "brewva.session.rewind.v1" as const;
export const SESSION_REDO_SCHEMA = "brewva.session.rewind.redo.v1" as const;
export const SESSION_SUPERSEDE_SCHEMA = "brewva.session.rewind.superseded.v1" as const;
export const SESSION_REWIND_DIVERGENCE_SCHEMA = "brewva.session.rewind.divergence.v1" as const;

export interface SessionPromptSnapshot {
  readonly text: string;
  readonly parts: readonly JsonValue[];
}

export interface RecordSessionRewindCheckpointInput {
  readonly turnId?: string;
  readonly leafEntryId?: string | null;
  readonly prompt?: SessionPromptSnapshot;
}

export type SessionRewindCheckpointStatus = "active" | "undone" | "redone" | "superseded";

export interface SessionRewindCheckpointRecord {
  readonly checkpointId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly reasoningCheckpointId: string;
  readonly leafEntryId: string | null;
  readonly prompt?: SessionPromptSnapshot;
  readonly turn: number;
  readonly eventId: string;
  readonly timestamp: number;
  readonly status: SessionRewindCheckpointStatus;
  readonly undoneAt?: number;
  readonly redoneAt?: number;
  readonly supersededAt?: number;
  readonly supersededByEventId?: string;
  readonly patchSetIds?: readonly string[];
  readonly returnLeafEntryId?: string | null;
}

export interface SessionRewindInput {
  readonly checkpointId?: string;
  readonly mode?: SessionRewindMode;
  readonly summary?: SessionRewindSummary;
  readonly summaryHint?: string;
  readonly returnLeafEntryId?: string | null;
}

export interface SessionRedoInput {
  readonly checkpointId?: string;
  readonly returnLeafEntryId?: string | null;
}

export interface SessionRewindDivergenceNote extends ProtocolRecord {
  readonly kind: "workspace_ahead" | "conversation_ahead";
  readonly text: string;
  readonly patchSetCount: number;
  readonly parentLeafEntryId: string | null;
}

export interface ReasoningRevertRecord extends ProtocolRecord {
  readonly targetLeafEntryId: string | null;
  readonly continuityPacket: {
    readonly text: string;
    readonly [key: string]: unknown;
  };
}

export type ReasoningCheckpointRecord = Record<string, unknown>;

export interface SessionRewindRecord {
  readonly eventId: string;
  readonly timestamp: number;
  readonly checkpointId: string;
  readonly trigger: SessionRewindTrigger;
  readonly mode: SessionRewindMode;
  readonly summary: SessionRewindSummary;
  readonly reasoningRevert?: ReasoningRevertRecord;
  readonly divergenceNote?: SessionRewindDivergenceNote;
  readonly abandonedCheckpointIds: readonly string[];
  readonly patchSetIds: readonly string[];
  readonly rollbackResults: readonly RollbackResult[];
  readonly returnLeafEntryId: string | null;
}

export interface SessionRedoRecord {
  readonly eventId: string;
  readonly timestamp: number;
  readonly checkpointId: string;
  readonly mode: SessionRewindMode;
  readonly patchSetIds: readonly string[];
  readonly redoResults: readonly RedoResult[];
  readonly returnLeafEntryId: string | null;
  readonly reasoningCheckpoint?: ReasoningCheckpointRecord;
}

export type SessionRewindFailureReason =
  | "no_checkpoint"
  | "checkpoint_not_rewindable"
  | "streaming"
  | "conflict"
  | "policy_denied"
  | "rollback_failed"
  | "reasoning_revert_failed";

export type SessionRedoFailureReason =
  | "no_redo"
  | "checkpoint_not_redoable"
  | "streaming"
  | "conflict"
  | "policy_denied"
  | "redo_failed"
  | "reasoning_checkpoint_failed";

export type SessionRewindResult =
  | {
      readonly ok: true;
      readonly checkpoint: SessionRewindCheckpointRecord;
      readonly reasoningRevert?: ReasoningRevertRecord;
      readonly divergenceNote?: SessionRewindDivergenceNote;
      readonly abandonedCheckpointIds: readonly string[];
      readonly patchSetIds: readonly string[];
      readonly rollbackResults: readonly RollbackResult[];
      readonly restoredPrompt?: SessionPromptSnapshot;
      readonly returnLeafEntryId: string | null;
      readonly trigger: SessionRewindTrigger;
      readonly mode: SessionRewindMode;
      readonly summary: SessionRewindSummary;
    }
  | {
      readonly ok: false;
      readonly reason: SessionRewindFailureReason;
      readonly checkpoint?: SessionRewindCheckpointRecord;
      readonly patchSetIds?: readonly string[];
      readonly rollbackResults?: readonly RollbackResult[];
      readonly compensationRedoResults?: readonly RedoResult[];
      readonly error?: string;
      readonly trigger: SessionRewindTrigger;
      readonly mode: SessionRewindMode;
      readonly summary: SessionRewindSummary;
    };

export type SessionRedoResult =
  | {
      readonly ok: true;
      readonly checkpoint: SessionRewindCheckpointRecord;
      readonly patchSetIds: readonly string[];
      readonly redoResults: readonly RedoResult[];
      readonly restoredPrompt?: SessionPromptSnapshot;
      readonly returnLeafEntryId: string | null;
      readonly reasoningCheckpoint?: ReasoningCheckpointRecord;
    }
  | {
      readonly ok: false;
      readonly reason: SessionRedoFailureReason;
      readonly checkpoint?: SessionRewindCheckpointRecord;
      readonly patchSetIds?: readonly string[];
      readonly redoResults?: readonly RedoResult[];
      readonly compensationRollbackResults?: readonly RollbackResult[];
      readonly error?: string;
    };

export type SessionRewindCompletedEventPayload =
  | {
      readonly schema: typeof SESSION_REWIND_SCHEMA;
      readonly ok: true;
      readonly checkpointId: string;
      readonly trigger: SessionRewindTrigger;
      readonly mode: SessionRewindMode;
      readonly summary: SessionRewindSummary;
      readonly reasoningRevertId: string | null;
      readonly reasoningRevertEventId: string | null;
      readonly divergenceNote: SessionRewindDivergenceNote | null;
      readonly abandonedCheckpointIds: readonly string[];
      readonly patchSetIds: readonly string[];
      readonly rollbackResults: readonly RollbackResult[];
      readonly returnLeafEntryId: string | null;
    }
  | {
      readonly schema: typeof SESSION_REWIND_SCHEMA;
      readonly ok: false;
      readonly checkpointId: string;
      readonly trigger: SessionRewindTrigger;
      readonly mode: SessionRewindMode;
      readonly summary: SessionRewindSummary;
      readonly patchSetIds: readonly string[];
      readonly rollbackResults: readonly RollbackResult[];
      readonly compensationRedoResults: readonly RedoResult[];
      readonly reason: SessionRewindFailureReason;
      readonly error: string | null;
    };

export type SessionRewindTargetLineage =
  | { readonly kind: "active" }
  | { readonly kind: "abandoned"; readonly rewoundBy: string; readonly rewoundAt: number };

export interface SessionRewindTargetView {
  readonly checkpointId: string;
  readonly turn: number;
  readonly timestamp: number;
  readonly promptPreview: string;
  readonly patchSetCountAfter: number;
  readonly fileSummary: {
    readonly added: number;
    readonly modified: number;
    readonly deleted: number;
  };
  readonly lineage: SessionRewindTargetLineage;
}

export interface SessionRewindState {
  readonly checkpoints: readonly SessionRewindCheckpointRecord[];
  readonly rewindAvailable: boolean;
  readonly redoAvailable: boolean;
  readonly latestRewindable?: SessionRewindCheckpointRecord;
  readonly nextRedoable?: SessionRewindCheckpointRecord;
  readonly latestRewind?: SessionRewindRecord;
  readonly redoStack: readonly SessionRedoRecord[];
}
