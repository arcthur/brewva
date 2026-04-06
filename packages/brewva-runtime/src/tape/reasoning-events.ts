import type {
  ReasoningCheckpointBoundary,
  ReasoningContinuityPacket,
  ReasoningRevertTrigger,
} from "../contracts/reasoning.js";
import {
  MAX_REASONING_CONTINUITY_BYTES,
  REASONING_CONTINUITY_SCHEMA,
} from "../contracts/reasoning.js";
import { isRecord, normalizeNonEmptyString } from "../utils/coerce.js";

export const REASONING_CHECKPOINT_EVENT_TYPE = "reasoning_checkpoint" as const;
export const REASONING_REVERT_EVENT_TYPE = "reasoning_revert" as const;

export const REASONING_CHECKPOINT_SCHEMA = "brewva.reasoning.checkpoint.v1" as const;
export const REASONING_REVERT_SCHEMA = "brewva.reasoning.revert.v1" as const;

const REASONING_CHECKPOINT_BOUNDARIES = [
  "turn_start",
  "tool_boundary",
  "verification_boundary",
  "compaction_boundary",
  "operator_marker",
] as const satisfies readonly ReasoningCheckpointBoundary[];

const REASONING_REVERT_TRIGGERS = [
  "model_self_repair",
  "operator_request",
  "verification_failure",
  "hosted_recovery",
] as const satisfies readonly ReasoningRevertTrigger[];

export interface ReasoningCheckpointPayload {
  schema: typeof REASONING_CHECKPOINT_SCHEMA;
  checkpointId: string;
  checkpointSequence: number;
  branchId: string;
  branchSequence: number;
  parentCheckpointId?: string;
  boundary: ReasoningCheckpointBoundary;
  leafEntryId?: string | null;
  createdAt: number;
}

export interface ReasoningRevertPayload {
  schema: typeof REASONING_REVERT_SCHEMA;
  revertId: string;
  revertSequence: number;
  toCheckpointId: string;
  fromCheckpointId?: string;
  fromBranchId: string;
  newBranchId: string;
  newBranchSequence: number;
  trigger: ReasoningRevertTrigger;
  continuityPacket: ReasoningContinuityPacket;
  linkedRollbackReceiptIds?: string[];
  targetLeafEntryId?: string | null;
  createdAt: number;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  const normalized = normalizeFiniteNumber(value);
  return normalized === null ? null : Math.max(0, Math.floor(normalized));
}

function normalizeBoundary(value: unknown): ReasoningCheckpointBoundary | null {
  return typeof value === "string" && REASONING_CHECKPOINT_BOUNDARIES.includes(value as never)
    ? (value as ReasoningCheckpointBoundary)
    : null;
}

function normalizeTrigger(value: unknown): ReasoningRevertTrigger | null {
  return typeof value === "string" && REASONING_REVERT_TRIGGERS.includes(value as never)
    ? (value as ReasoningRevertTrigger)
    : null;
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeNonEmptyString(item);
    if (!normalized) {
      return undefined;
    }
    out.push(normalized);
  }
  return out;
}

export function normalizeReasoningContinuityPacket(
  input: string | ReasoningContinuityPacket,
): ReasoningContinuityPacket {
  const text =
    typeof input === "string"
      ? input.trim()
      : typeof input?.text === "string"
        ? input.text.trim()
        : "";
  if (text.length === 0) {
    throw new Error("reasoning continuity text must be non-empty");
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_REASONING_CONTINUITY_BYTES) {
    throw new Error(
      `reasoning continuity exceeds ${MAX_REASONING_CONTINUITY_BYTES} bytes (${byteLength})`,
    );
  }
  return {
    schema: REASONING_CONTINUITY_SCHEMA,
    text,
  };
}

export function coerceReasoningContinuityPacket(value: unknown): ReasoningContinuityPacket | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== REASONING_CONTINUITY_SCHEMA) {
    return null;
  }
  try {
    return normalizeReasoningContinuityPacket({
      schema: REASONING_CONTINUITY_SCHEMA,
      text: typeof value.text === "string" ? value.text : "",
    });
  } catch {
    return null;
  }
}

export function buildReasoningCheckpointPayload(input: {
  checkpointId: string;
  checkpointSequence: number;
  branchId: string;
  branchSequence: number;
  parentCheckpointId?: string | null;
  boundary: ReasoningCheckpointBoundary;
  leafEntryId?: string | null;
  createdAt?: number;
}): ReasoningCheckpointPayload {
  return {
    schema: REASONING_CHECKPOINT_SCHEMA,
    checkpointId: input.checkpointId,
    checkpointSequence: input.checkpointSequence,
    branchId: input.branchId,
    branchSequence: input.branchSequence,
    ...(input.parentCheckpointId ? { parentCheckpointId: input.parentCheckpointId } : {}),
    boundary: input.boundary,
    ...(input.leafEntryId !== undefined ? { leafEntryId: input.leafEntryId } : {}),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function buildReasoningRevertPayload(input: {
  revertId: string;
  revertSequence: number;
  toCheckpointId: string;
  fromCheckpointId?: string | null;
  fromBranchId: string;
  newBranchId: string;
  newBranchSequence: number;
  trigger: ReasoningRevertTrigger;
  continuityPacket: string | ReasoningContinuityPacket;
  linkedRollbackReceiptIds?: readonly string[];
  targetLeafEntryId?: string | null;
  createdAt?: number;
}): ReasoningRevertPayload {
  return {
    schema: REASONING_REVERT_SCHEMA,
    revertId: input.revertId,
    revertSequence: input.revertSequence,
    toCheckpointId: input.toCheckpointId,
    ...(input.fromCheckpointId ? { fromCheckpointId: input.fromCheckpointId } : {}),
    fromBranchId: input.fromBranchId,
    newBranchId: input.newBranchId,
    newBranchSequence: input.newBranchSequence,
    trigger: input.trigger,
    continuityPacket: normalizeReasoningContinuityPacket(input.continuityPacket),
    ...(input.linkedRollbackReceiptIds && input.linkedRollbackReceiptIds.length > 0
      ? { linkedRollbackReceiptIds: [...input.linkedRollbackReceiptIds] }
      : {}),
    ...(input.targetLeafEntryId !== undefined
      ? { targetLeafEntryId: input.targetLeafEntryId }
      : {}),
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function coerceReasoningCheckpointPayload(
  value: unknown,
): ReasoningCheckpointPayload | null {
  if (!isRecord(value) || value.schema !== REASONING_CHECKPOINT_SCHEMA) {
    return null;
  }
  const checkpointId = normalizeNonEmptyString(value.checkpointId);
  const checkpointSequence = normalizeNonNegativeInteger(value.checkpointSequence);
  const branchId = normalizeNonEmptyString(value.branchId);
  const branchSequence = normalizeNonNegativeInteger(value.branchSequence);
  const boundary = normalizeBoundary(value.boundary);
  const createdAt = normalizeFiniteNumber(value.createdAt);
  if (
    !checkpointId ||
    checkpointSequence === null ||
    !branchId ||
    branchSequence === null ||
    !boundary ||
    createdAt === null
  ) {
    return null;
  }
  return {
    schema: REASONING_CHECKPOINT_SCHEMA,
    checkpointId,
    checkpointSequence,
    branchId,
    branchSequence,
    ...(normalizeNonEmptyString(value.parentCheckpointId)
      ? { parentCheckpointId: normalizeNonEmptyString(value.parentCheckpointId)! }
      : {}),
    boundary,
    ...(value.leafEntryId === null
      ? { leafEntryId: null }
      : normalizeNonEmptyString(value.leafEntryId)
        ? { leafEntryId: normalizeNonEmptyString(value.leafEntryId)! }
        : {}),
    createdAt,
  };
}

export function coerceReasoningRevertPayload(value: unknown): ReasoningRevertPayload | null {
  if (!isRecord(value) || value.schema !== REASONING_REVERT_SCHEMA) {
    return null;
  }
  const revertId = normalizeNonEmptyString(value.revertId);
  const revertSequence = normalizeNonNegativeInteger(value.revertSequence);
  const toCheckpointId = normalizeNonEmptyString(value.toCheckpointId);
  const fromCheckpointId = normalizeNonEmptyString(value.fromCheckpointId);
  const fromBranchId = normalizeNonEmptyString(value.fromBranchId);
  const newBranchId = normalizeNonEmptyString(value.newBranchId);
  const newBranchSequence = normalizeNonNegativeInteger(value.newBranchSequence);
  const trigger = normalizeTrigger(value.trigger);
  const continuityPacket = coerceReasoningContinuityPacket(value.continuityPacket);
  const linkedRollbackReceiptIds = normalizeOptionalStringArray(value.linkedRollbackReceiptIds);
  const createdAt = normalizeFiniteNumber(value.createdAt);
  if (
    !revertId ||
    revertSequence === null ||
    !toCheckpointId ||
    !fromBranchId ||
    !newBranchId ||
    newBranchSequence === null ||
    !trigger ||
    !continuityPacket ||
    createdAt === null
  ) {
    return null;
  }
  return {
    schema: REASONING_REVERT_SCHEMA,
    revertId,
    revertSequence,
    toCheckpointId,
    ...(fromCheckpointId ? { fromCheckpointId } : {}),
    fromBranchId,
    newBranchId,
    newBranchSequence,
    trigger,
    continuityPacket,
    ...(linkedRollbackReceiptIds ? { linkedRollbackReceiptIds } : {}),
    ...(value.targetLeafEntryId === null
      ? { targetLeafEntryId: null }
      : normalizeNonEmptyString(value.targetLeafEntryId)
        ? { targetLeafEntryId: normalizeNonEmptyString(value.targetLeafEntryId)! }
        : {}),
    createdAt,
  };
}
