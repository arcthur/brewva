export const REASONING_CONTINUITY_SCHEMA = "brewva.reasoning.continuity.v1" as const;

export const MAX_REASONING_CONTINUITY_BYTES = 1_200;

export type ReasoningCheckpointBoundary =
  | "turn_start"
  | "tool_boundary"
  | "verification_boundary"
  | "compaction_boundary"
  | "operator_marker";

export type ReasoningRevertTrigger =
  | "model_self_repair"
  | "operator_request"
  | "verification_failure"
  | "hosted_recovery";

export interface ReasoningContinuityPacket {
  schema: typeof REASONING_CONTINUITY_SCHEMA;
  text: string;
}

export interface ReasoningCheckpointRecord {
  checkpointId: string;
  checkpointSequence: number;
  branchId: string;
  branchSequence: number;
  parentCheckpointId: string | null;
  boundary: ReasoningCheckpointBoundary;
  leafEntryId: string | null;
  turn: number;
  eventId: string;
  timestamp: number;
}

export interface ReasoningRevertRecord {
  revertId: string;
  revertSequence: number;
  toCheckpointId: string;
  fromCheckpointId: string | null;
  fromBranchId: string;
  newBranchId: string;
  newBranchSequence: number;
  trigger: ReasoningRevertTrigger;
  continuityPacket: ReasoningContinuityPacket;
  linkedRollbackReceiptIds: string[];
  targetLeafEntryId: string | null;
  turn: number;
  eventId: string;
  timestamp: number;
}

export interface ActiveReasoningBranchState {
  sessionId: string;
  rootBranchId: string;
  activeBranchId: string;
  activeBranchSequence: number;
  activeCheckpointId: string | null;
  activeCheckpoint?: ReasoningCheckpointRecord;
  activeLineageCheckpointIds: string[];
  latestRevert?: ReasoningRevertRecord;
  latestContinuityPacket?: ReasoningContinuityPacket;
  checkpoints: ReasoningCheckpointRecord[];
  reverts: ReasoningRevertRecord[];
  nextCheckpointSequence: number;
  nextBranchSequence: number;
  nextRevertSequence: number;
}

export interface RecordReasoningCheckpointInput {
  boundary: ReasoningCheckpointBoundary;
  leafEntryId?: string | null;
}

export interface ReasoningRevertInput {
  toCheckpointId: string;
  trigger: ReasoningRevertTrigger;
  continuity: string | ReasoningContinuityPacket;
  linkedRollbackReceiptIds?: readonly string[];
}
