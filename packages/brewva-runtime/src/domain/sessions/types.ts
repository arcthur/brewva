import type { BrewvaConfig } from "../../config/types.js";
import type { BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { JsonValue } from "../../core/shared.js";
import type { RedoResult, RollbackResult } from "../patching/api.js";
import type { ReasoningCheckpointRecord, ReasoningRevertRecord } from "../reasoning/types.js";
import type { SkillRoutingScope } from "../skills/api.js";
import type { IntegrityIssue } from "./integrity.js";

export type ManagedToolMode = "hosted" | "direct";

export interface CreateBrewvaSessionOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  model?: string;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
  routingDefaultScopes?: SkillRoutingScope[];
  managedToolMode?: ManagedToolMode;
}

export interface SessionHydrationState {
  status: "cold" | "ready" | "degraded";
  latestEventId?: string;
  hydratedAt?: number;
  issues: IntegrityIssue[];
}

export interface OpenToolCallRecord {
  toolCallId: BrewvaToolCallId;
  toolName: BrewvaToolName;
  openedAt: number;
  turn?: number;
  attempt?: number | null;
  eventId?: string;
}

export interface OpenTurnRecord {
  turn: number;
  startedAt: number;
  eventId?: string;
}

export type SessionUncleanShutdownReason =
  | "open_tool_calls_without_terminal_receipt"
  | "open_turn_without_terminal_receipt";

export interface SessionUncleanShutdownDiagnostic {
  detectedAt: number;
  reasons: SessionUncleanShutdownReason[];
  openToolCalls: OpenToolCallRecord[];
  openTurns?: OpenTurnRecord[];
  latestEventType?: string;
  latestEventAt?: number;
}

export type SessionTitleSource = "llm";

export interface SessionTitleRecordedModel {
  provider: string;
  id: string;
  api?: string;
}

export interface SessionTitleRecordedPayload {
  title: string;
  source: SessionTitleSource;
  turnId: string;
  promptEventId: string;
  model: SessionTitleRecordedModel;
  generatedAt: number;
}

export interface SessionTitleView extends SessionTitleRecordedPayload {
  sessionId: string;
  eventId: string;
  timestamp: number;
}

export interface RecordGeneratedSessionTitleInput {
  title: string;
  turnId: string;
  promptEventId: string;
  model: SessionTitleRecordedModel;
  generatedAt?: number;
}

export type SessionRewindMode = "conversation" | "code" | "both";

export type SessionRewindSummary = "none" | "carry";

export type SessionRewindTrigger = "undo" | "rewind";

export const SESSION_REWIND_CHECKPOINT_SCHEMA = "brewva.session.rewind.checkpoint.v1" as const;
export const SESSION_REWIND_SCHEMA = "brewva.session.rewind.v1" as const;
export const SESSION_REDO_SCHEMA = "brewva.session.rewind.redo.v1" as const;
export const SESSION_SUPERSEDE_SCHEMA = "brewva.session.rewind.superseded.v1" as const;

export interface SessionPromptSnapshot {
  text: string;
  parts: JsonValue[];
}

export interface RecordSessionRewindCheckpointInput {
  turnId?: string;
  leafEntryId?: string | null;
  prompt?: SessionPromptSnapshot;
}

export type SessionRewindCheckpointStatus = "active" | "undone" | "redone" | "superseded";

export interface SessionRewindCheckpointRecord {
  checkpointId: string;
  sessionId: string;
  turnId: string;
  reasoningCheckpointId: string;
  leafEntryId: string | null;
  prompt?: SessionPromptSnapshot;
  turn: number;
  eventId: string;
  timestamp: number;
  status: SessionRewindCheckpointStatus;
  undoneAt?: number;
  redoneAt?: number;
  supersededAt?: number;
  supersededByEventId?: string;
  patchSetIds?: string[];
  returnLeafEntryId?: string | null;
}

export interface SessionRewindInput {
  checkpointId?: string;
  mode?: SessionRewindMode;
  summary?: SessionRewindSummary;
  summaryHint?: string;
  returnLeafEntryId?: string | null;
}

export interface SessionRedoInput {
  checkpointId?: string;
  returnLeafEntryId?: string | null;
}

export const SESSION_REWIND_DIVERGENCE_SCHEMA = "brewva.session.rewind.divergence.v1" as const;

export interface SessionRewindDivergenceNote {
  kind: "workspace_ahead" | "conversation_ahead";
  text: string;
  patchSetCount: number;
  parentLeafEntryId: string | null;
}

export interface SessionRewindRecord {
  eventId: string;
  timestamp: number;
  checkpointId: string;
  trigger: SessionRewindTrigger;
  mode: SessionRewindMode;
  summary: SessionRewindSummary;
  reasoningRevert?: ReasoningRevertRecord;
  divergenceNote?: SessionRewindDivergenceNote;
  abandonedCheckpointIds: string[];
  patchSetIds: string[];
  rollbackResults: RollbackResult[];
  returnLeafEntryId: string | null;
}

export interface SessionRedoRecord {
  eventId: string;
  timestamp: number;
  checkpointId: string;
  mode: SessionRewindMode;
  patchSetIds: string[];
  redoResults: RedoResult[];
  returnLeafEntryId: string | null;
  reasoningCheckpoint?: ReasoningCheckpointRecord;
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
      ok: true;
      checkpoint: SessionRewindCheckpointRecord;
      reasoningRevert?: ReasoningRevertRecord;
      divergenceNote?: SessionRewindDivergenceNote;
      abandonedCheckpointIds: string[];
      patchSetIds: string[];
      rollbackResults: RollbackResult[];
      restoredPrompt?: SessionPromptSnapshot;
      returnLeafEntryId: string | null;
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
    }
  | {
      ok: false;
      reason: SessionRewindFailureReason;
      checkpoint?: SessionRewindCheckpointRecord;
      patchSetIds?: string[];
      rollbackResults?: RollbackResult[];
      compensationRedoResults?: RedoResult[];
      error?: string;
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
    };

export type SessionRedoResult =
  | {
      ok: true;
      checkpoint: SessionRewindCheckpointRecord;
      patchSetIds: string[];
      redoResults: RedoResult[];
      restoredPrompt?: SessionPromptSnapshot;
      returnLeafEntryId: string | null;
      reasoningCheckpoint?: ReasoningCheckpointRecord;
    }
  | {
      ok: false;
      reason: SessionRedoFailureReason;
      checkpoint?: SessionRewindCheckpointRecord;
      patchSetIds?: string[];
      redoResults?: RedoResult[];
      compensationRollbackResults?: RollbackResult[];
      error?: string;
    };

export type SessionRewindCompletedEventPayload =
  | {
      schema: typeof SESSION_REWIND_SCHEMA;
      ok: true;
      checkpointId: string;
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
      reasoningRevertId: string | null;
      reasoningRevertEventId: string | null;
      divergenceNote: SessionRewindDivergenceNote | null;
      abandonedCheckpointIds: string[];
      patchSetIds: string[];
      rollbackResults: RollbackResult[];
      returnLeafEntryId: string | null;
    }
  | {
      schema: typeof SESSION_REWIND_SCHEMA;
      ok: false;
      checkpointId: string;
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
      patchSetIds: string[];
      rollbackResults: RollbackResult[];
      compensationRedoResults: RedoResult[];
      reason: SessionRewindFailureReason;
      error: string | null;
    };

export type SessionUncleanShutdownReconciledPayload = SessionUncleanShutdownDiagnostic;

export type SessionRewindTargetLineage =
  | { kind: "active" }
  | { kind: "abandoned"; rewoundBy: string; rewoundAt: number };

export interface SessionRewindTargetView {
  checkpointId: string;
  turn: number;
  timestamp: number;
  promptPreview: string;
  patchSetCountAfter: number;
  fileSummary: {
    added: number;
    modified: number;
    deleted: number;
  };
  lineage: SessionRewindTargetLineage;
}

export interface SessionRewindState {
  checkpoints: SessionRewindCheckpointRecord[];
  rewindAvailable: boolean;
  redoAvailable: boolean;
  latestRewindable?: SessionRewindCheckpointRecord;
  nextRedoable?: SessionRewindCheckpointRecord;
  latestRewind?: SessionRewindRecord;
  redoStack: SessionRedoRecord[];
}
