import { asBrewvaToolCallId, asBrewvaToolName } from "../../core/identifiers.js";
import {
  asRecord,
  readNonNegativeNumber,
  readNullableString,
  readString,
  readStringArray,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventDescriptor,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import type { RedoResult, RollbackResult } from "../patching/types.js";
import { SEMANTIC_ARTIFACT_SCHEMA_IDS } from "../skills/types.js";
import type {
  ActiveSkillRuntimeState,
  SemanticArtifactSchemaId,
  SkillCompletionFailureRecord,
  SkillOutputValidationIssue,
  SkillRepairBudgetState,
  SkillRepairGuidance,
} from "../skills/types.js";
import {
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "./events.js";
import type {
  OpenToolCallRecord,
  OpenTurnRecord,
  SessionRewindDivergenceNote,
  SessionRewindFailureReason,
  SessionRewindMode,
  SessionRewindSummary,
  SessionRewindTrigger,
  SessionUncleanShutdownDiagnostic,
  SessionUncleanShutdownReason,
  SessionRewindCompletedEventPayload,
} from "./types.js";
import { SESSION_REWIND_SCHEMA } from "./types.js";
import type {
  SessionWireCommittedStatus,
  SessionWireTransitionFamily,
  SessionTurnTransitionPayload,
  SessionTurnTransitionReason,
  SessionWireTransitionStatus,
  SessionWireTurnTrigger,
  ToolOutputDisplayView,
  ToolOutputView,
  TurnInputRecordedPayload,
  TurnRenderCommittedPayload,
} from "./wire.js";

export {
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "./events.js";

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readRequiredBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isSessionWireTurnTrigger(value: unknown): value is SessionWireTurnTrigger {
  return (
    value === "user" ||
    value === "schedule" ||
    value === "heartbeat" ||
    value === "channel" ||
    value === "recovery" ||
    value === "subagent"
  );
}

function isSessionWireCommittedStatus(value: unknown): value is SessionWireCommittedStatus {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function isSessionWireTransitionStatus(value: unknown): value is SessionWireTransitionStatus {
  return value === "entered" || value === "completed" || value === "failed" || value === "skipped";
}

function isSessionWireTransitionFamily(value: unknown): value is SessionWireTransitionFamily {
  return (
    value === "context" ||
    value === "output_budget" ||
    value === "approval" ||
    value === "delegation" ||
    value === "interrupt" ||
    value === "recovery"
  );
}

function isSemanticArtifactSchemaId(value: string): value is SemanticArtifactSchemaId {
  return (SEMANTIC_ARTIFACT_SCHEMA_IDS as readonly string[]).includes(value);
}

function isSessionTurnTransitionReason(value: unknown): value is SessionTurnTransitionReason {
  return (
    value === "compaction_gate_blocked" ||
    value === "compaction_retry" ||
    value === "effect_commitment_pending" ||
    value === "output_budget_escalation" ||
    value === "provider_fallback_retry" ||
    value === "max_output_recovery" ||
    value === "reasoning_revert_resume" ||
    value === "subagent_delivery_pending" ||
    value === "wal_recovery_resume" ||
    value === "user_submit_interrupt" ||
    value === "signal_interrupt" ||
    value === "timeout_interrupt"
  );
}

function isSessionRewindTrigger(value: unknown): value is SessionRewindTrigger {
  return value === "undo" || value === "rewind";
}

function isSessionRewindMode(value: unknown): value is SessionRewindMode {
  return value === "conversation" || value === "code" || value === "both";
}

function isSessionRewindSummary(value: unknown): value is SessionRewindSummary {
  return value === "none" || value === "carry";
}

function isSessionRewindFailureReason(value: unknown): value is SessionRewindFailureReason {
  return (
    value === "no_checkpoint" ||
    value === "checkpoint_not_rewindable" ||
    value === "streaming" ||
    value === "conflict" ||
    value === "policy_denied" ||
    value === "rollback_failed" ||
    value === "reasoning_revert_failed"
  );
}

function readToolOutputDisplayView(value: unknown): ToolOutputDisplayView | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const summaryText = readString(record.summaryText);
  const detailsText = readString(record.detailsText);
  const rawText = readString(record.rawText);
  const display: ToolOutputDisplayView = {};
  if (summaryText) {
    display.summaryText = summaryText;
  }
  if (detailsText) {
    display.detailsText = detailsText;
  }
  if (rawText) {
    display.rawText = rawText;
  }
  return Object.keys(display).length > 0 ? display : undefined;
}

function readToolOutputView(value: unknown): ToolOutputView | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  const verdict = record.verdict;
  if (!toolCallId || !toolName) {
    return null;
  }
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return null;
  }
  const display = readToolOutputDisplayView(record.display);
  return {
    toolCallId: asBrewvaToolCallId(toolCallId),
    toolName: asBrewvaToolName(toolName),
    verdict,
    isError: readBoolean(record.isError),
    text: readString(record.text) ?? "",
    ...(display ? { display } : {}),
  };
}

function readToolOutputViews(value: unknown): ToolOutputView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readToolOutputView(entry))
    .filter((entry): entry is ToolOutputView => entry !== null);
}

function readSessionTurnTransitionPayloadValue(
  payload: unknown,
): SessionTurnTransitionPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const reason = record.reason;
  const status = record.status;
  const family = record.family;
  const sequence = readNonNegativeNumber(record.sequence);
  if (
    !isSessionTurnTransitionReason(reason) ||
    !isSessionWireTransitionStatus(status) ||
    !isSessionWireTransitionFamily(family) ||
    sequence === null
  ) {
    return null;
  }
  const attempt = record.attempt === null ? null : readNonNegativeNumber(record.attempt);
  if (record.attempt !== undefined && record.attempt !== null && attempt === null) {
    return null;
  }
  return {
    reason,
    status,
    sequence,
    family,
    attempt: attempt ?? null,
    sourceEventId: readString(record.sourceEventId),
    sourceEventType: readString(record.sourceEventType),
    error: readString(record.error),
    breakerOpen: readBoolean(record.breakerOpen),
    model: readString(record.model),
  };
}

function readRollbackResultsValue(value: unknown): RollbackResult[] | null {
  return Array.isArray(value) ? (structuredClone(value) as RollbackResult[]) : null;
}

function readRedoResultsValue(value: unknown): RedoResult[] | null {
  return Array.isArray(value) ? (structuredClone(value) as RedoResult[]) : null;
}

function readSessionRewindDivergenceNoteValue(value: unknown): SessionRewindDivergenceNote | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind =
    record.kind === "workspace_ahead" || record.kind === "conversation_ahead" ? record.kind : null;
  const text = readString(record.text);
  const patchSetCount = readNonNegativeNumber(record.patchSetCount);
  const parentLeafEntryId = readNullableString(record.parentLeafEntryId);
  if (
    !kind ||
    !text ||
    patchSetCount === null ||
    (record.parentLeafEntryId !== undefined &&
      record.parentLeafEntryId !== null &&
      parentLeafEntryId === null)
  ) {
    return null;
  }
  return {
    kind,
    text,
    patchSetCount,
    parentLeafEntryId,
  };
}

function readSessionRewindCompletedEventPayloadValue(
  payload: unknown,
): SessionRewindCompletedEventPayload | null {
  const record = asRecord(payload);
  if (!record || record.schema !== SESSION_REWIND_SCHEMA) {
    return null;
  }
  const ok = readRequiredBoolean(record.ok);
  const checkpointId = readString(record.checkpointId);
  const trigger = isSessionRewindTrigger(record.trigger) ? record.trigger : null;
  const mode = isSessionRewindMode(record.mode) ? record.mode : null;
  const summary = isSessionRewindSummary(record.summary) ? record.summary : null;
  if (
    !checkpointId ||
    ok === null ||
    !trigger ||
    !mode ||
    !summary ||
    !Array.isArray(record.patchSetIds)
  ) {
    return null;
  }
  const normalizedPatchSetIds = readStringArray(record.patchSetIds);
  const rollbackResults = readRollbackResultsValue(record.rollbackResults);
  if (!rollbackResults) {
    return null;
  }
  if (ok) {
    const abandonedCheckpointIds = Array.isArray(record.abandonedCheckpointIds)
      ? readStringArray(record.abandonedCheckpointIds)
      : null;
    if (abandonedCheckpointIds === null) {
      return null;
    }
    const divergenceNote =
      record.divergenceNote === null || record.divergenceNote === undefined
        ? null
        : readSessionRewindDivergenceNoteValue(record.divergenceNote);
    const reasoningRevertId = readNullableString(record.reasoningRevertId);
    const reasoningRevertEventId = readNullableString(record.reasoningRevertEventId);
    const returnLeafEntryId = readNullableString(record.returnLeafEntryId);
    if (
      (record.divergenceNote !== null && record.divergenceNote !== undefined && !divergenceNote) ||
      (record.reasoningRevertId !== undefined &&
        record.reasoningRevertId !== null &&
        reasoningRevertId === null) ||
      (record.reasoningRevertEventId !== undefined &&
        record.reasoningRevertEventId !== null &&
        reasoningRevertEventId === null) ||
      (record.returnLeafEntryId !== undefined &&
        record.returnLeafEntryId !== null &&
        returnLeafEntryId === null)
    ) {
      return null;
    }
    return {
      schema: SESSION_REWIND_SCHEMA,
      ok: true,
      checkpointId,
      trigger,
      mode,
      summary,
      reasoningRevertId,
      reasoningRevertEventId,
      divergenceNote,
      abandonedCheckpointIds,
      patchSetIds: normalizedPatchSetIds,
      rollbackResults,
      returnLeafEntryId,
    };
  }
  const compensationRedoResults = readRedoResultsValue(record.compensationRedoResults);
  const reason = isSessionRewindFailureReason(record.reason) ? record.reason : null;
  if (!compensationRedoResults || !reason) {
    return null;
  }
  return {
    schema: SESSION_REWIND_SCHEMA,
    ok: false,
    checkpointId,
    trigger,
    mode,
    summary,
    patchSetIds: normalizedPatchSetIds,
    rollbackResults,
    compensationRedoResults,
    reason,
    error: readNullableString(record.error),
  };
}

function readUncleanShutdownReason(value: unknown): SessionUncleanShutdownReason | null {
  return value === "open_tool_calls_without_terminal_receipt" ||
    value === "open_turn_without_terminal_receipt" ||
    value === "active_skill_without_terminal_receipt"
    ? value
    : null;
}

function readSkillOutputValidationIssue(value: unknown): SkillOutputValidationIssue | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = readString(record.name);
  const reason = readString(record.reason);
  if (!name || !reason) {
    return null;
  }
  const schemaId = readString(record.schemaId);
  return {
    name,
    reason,
    ...(schemaId && isSemanticArtifactSchemaId(schemaId) ? { schemaId } : {}),
  };
}

function readRepairBudget(value: unknown): SkillRepairBudgetState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const maxAttempts = readNonNegativeNumber(record.maxAttempts);
  const usedAttempts = readNonNegativeNumber(record.usedAttempts);
  const remainingAttempts = readNonNegativeNumber(record.remainingAttempts);
  const maxToolCalls = readNonNegativeNumber(record.maxToolCalls);
  const usedToolCalls = readNonNegativeNumber(record.usedToolCalls);
  const remainingToolCalls = readNonNegativeNumber(record.remainingToolCalls);
  const tokenBudget = readNonNegativeNumber(record.tokenBudget);
  if (
    maxAttempts === null ||
    usedAttempts === null ||
    remainingAttempts === null ||
    maxToolCalls === null ||
    usedToolCalls === null ||
    remainingToolCalls === null ||
    tokenBudget === null
  ) {
    return null;
  }
  const enteredAtTokens = readNonNegativeNumber(record.enteredAtTokens);
  const latestObservedTokens = readNonNegativeNumber(record.latestObservedTokens);
  const usedTokens = readNonNegativeNumber(record.usedTokens);
  return {
    maxAttempts,
    usedAttempts,
    remainingAttempts,
    maxToolCalls,
    usedToolCalls,
    remainingToolCalls,
    tokenBudget,
    ...(enteredAtTokens !== null ? { enteredAtTokens } : {}),
    ...(latestObservedTokens !== null ? { latestObservedTokens } : {}),
    ...(usedTokens !== null ? { usedTokens } : {}),
  };
}

function readRepairGuidance(value: unknown): SkillRepairGuidance | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const minimumContractState = readString(record.minimumContractState);
  if (!minimumContractState) {
    return undefined;
  }
  const unresolvedFields = readStringArray(record.unresolvedFields);
  const nextBlockingConsumer = readString(record.nextBlockingConsumer);
  return {
    unresolvedFields,
    minimumContractState,
    ...(nextBlockingConsumer ? { nextBlockingConsumer } : {}),
  };
}

function readCompletionFailure(value: unknown): SkillCompletionFailureRecord | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const skillName = readString(record.skillName);
  const phase =
    record.phase === "repair_required" || record.phase === "failed_contract"
      ? record.phase
      : undefined;
  const repairBudget = readRepairBudget(record.repairBudget);
  if (!skillName || !phase || !repairBudget) {
    return undefined;
  }
  const invalid = Array.isArray(record.invalid)
    ? record.invalid
        .map((entry) => readSkillOutputValidationIssue(entry))
        .filter((entry): entry is SkillOutputValidationIssue => entry !== null)
    : [];
  return {
    skillName,
    occurredAt: readNonNegativeNumber(record.occurredAt) ?? 0,
    phase,
    outputKeys: readStringArray(record.outputKeys),
    missing: readStringArray(record.missing),
    invalid,
    expectedOutputs: asRecord(record.expectedOutputs) ?? {},
    repairGuidance: readRepairGuidance(record.repairGuidance),
    repairBudget,
  };
}

function readActiveSkillState(value: unknown): ActiveSkillRuntimeState | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const skillName = readString(record.skillName);
  const phase =
    record.phase === "active" || record.phase === "repair_required" ? record.phase : undefined;
  if (!skillName || !phase) {
    return undefined;
  }
  const latestFailure = readCompletionFailure(record.latestFailure);
  return {
    skillName,
    phase,
    ...(latestFailure ? { repairBudget: latestFailure.repairBudget, latestFailure } : {}),
  };
}

function readOpenToolCallRecord(value: unknown): OpenToolCallRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  const openedAt = readNonNegativeNumber(record.openedAt);
  if (!toolCallId || !toolName || openedAt === null) {
    return null;
  }
  const turn = readNonNegativeNumber(record.turn);
  const attempt = record.attempt === null ? null : readNonNegativeNumber(record.attempt);
  if (record.attempt !== undefined && record.attempt !== null && attempt === null) {
    return null;
  }
  const eventId = readString(record.eventId);
  return {
    toolCallId: asBrewvaToolCallId(toolCallId),
    toolName: asBrewvaToolName(toolName),
    openedAt,
    ...(turn !== null ? { turn } : {}),
    ...(record.attempt !== undefined ? { attempt: attempt ?? null } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

function readOpenTurnRecord(value: unknown): OpenTurnRecord | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const turn = readNonNegativeNumber(record.turn);
  const startedAt = readNonNegativeNumber(record.startedAt);
  if (turn === null || startedAt === null) {
    return null;
  }
  const eventId = readString(record.eventId);
  return {
    turn,
    startedAt,
    ...(eventId ? { eventId } : {}),
  };
}

function readSessionUncleanShutdownDiagnosticValue(
  payload: unknown,
): SessionUncleanShutdownDiagnostic | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const reasons = Array.isArray(record.reasons)
    ? record.reasons
        .map((entry) => readUncleanShutdownReason(entry))
        .filter((entry): entry is SessionUncleanShutdownReason => entry !== null)
    : [];
  if (reasons.length === 0) {
    return null;
  }
  const openToolCalls = Array.isArray(record.openToolCalls)
    ? record.openToolCalls
        .map((entry) => readOpenToolCallRecord(entry))
        .filter((entry): entry is OpenToolCallRecord => entry !== null)
    : [];
  const openTurns = Array.isArray(record.openTurns)
    ? record.openTurns
        .map((entry) => readOpenTurnRecord(entry))
        .filter((entry): entry is OpenTurnRecord => entry !== null)
    : [];
  const latestEventAt = readNonNegativeNumber(record.latestEventAt);
  const activeSkill = readActiveSkillState(record.activeSkill);
  const latestFailure = readCompletionFailure(record.latestFailure);
  return {
    detectedAt: readNonNegativeNumber(record.detectedAt) ?? 0,
    reasons,
    openToolCalls,
    ...(openTurns.length > 0 ? { openTurns } : {}),
    ...(activeSkill ? { activeSkill } : {}),
    ...(latestFailure ? { latestFailure } : {}),
    ...(readString(record.latestEventType)
      ? { latestEventType: readString(record.latestEventType)! }
      : {}),
    ...(latestEventAt !== null ? { latestEventAt } : {}),
  };
}

export const TURN_INPUT_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TURN_INPUT_RECORDED_EVENT_TYPE,
  category: "turn",
  durability: "source_of_truth",
  readPayload(payload): TurnInputRecordedPayload | null {
    const record = asRecord(payload);
    if (!record) {
      return null;
    }
    const turnId = readString(record.turnId);
    const trigger = record.trigger;
    const promptText = typeof record.promptText === "string" ? record.promptText : undefined;
    if (!turnId || !isSessionWireTurnTrigger(trigger) || promptText === undefined) {
      return null;
    }
    return {
      turnId,
      trigger,
      promptText,
    };
  },
});

export const TURN_RENDER_COMMITTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TURN_RENDER_COMMITTED_EVENT_TYPE,
  category: "turn",
  durability: "source_of_truth",
  readPayload(payload): TurnRenderCommittedPayload | null {
    const record = asRecord(payload);
    if (!record) {
      return null;
    }
    const turnId = readString(record.turnId);
    const attemptId = readString(record.attemptId);
    const status = record.status;
    const assistantText = typeof record.assistantText === "string" ? record.assistantText : "";
    if (!turnId || !attemptId || !isSessionWireCommittedStatus(status)) {
      return null;
    }
    return {
      turnId,
      attemptId,
      status,
      assistantText,
      toolOutputs: readToolOutputViews(record.toolOutputs),
    };
  },
});

export const SESSION_TURN_TRANSITION_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_TURN_TRANSITION_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionTurnTransitionPayloadValue,
});

export const SESSION_REWIND_COMPLETED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
  category: "state",
  durability: "source_of_truth",
  readPayload: readSessionRewindCompletedEventPayloadValue,
});

export const SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionUncleanShutdownDiagnosticValue,
});

export const SESSIONS_EVENT_DESCRIPTORS = [
  TURN_INPUT_RECORDED_EVENT_DESCRIPTOR,
  TURN_RENDER_COMMITTED_EVENT_DESCRIPTOR,
  SESSION_TURN_TRANSITION_EVENT_DESCRIPTOR,
  SESSION_REWIND_COMPLETED_EVENT_DESCRIPTOR,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_DESCRIPTOR,
] as const satisfies readonly BrewvaEventDescriptor<string, unknown>[];

export function readTurnInputRecordedEventPayload(
  event: BrewvaEventLike,
): TurnInputRecordedPayload | null {
  return readBrewvaEventPayload(event, TURN_INPUT_RECORDED_EVENT_DESCRIPTOR);
}

export function readTurnRenderCommittedEventPayload(
  event: BrewvaEventLike,
): TurnRenderCommittedPayload | null {
  return readBrewvaEventPayload(event, TURN_RENDER_COMMITTED_EVENT_DESCRIPTOR);
}

export function readSessionTurnTransitionEventPayload(
  event: BrewvaEventLike,
): SessionTurnTransitionPayload | null {
  return readBrewvaEventPayload(event, SESSION_TURN_TRANSITION_EVENT_DESCRIPTOR);
}

export function readSessionRewindCompletedEventPayload(
  event: BrewvaEventLike,
): SessionRewindCompletedEventPayload | null {
  return readBrewvaEventPayload(event, SESSION_REWIND_COMPLETED_EVENT_DESCRIPTOR);
}

export function readSessionUncleanShutdownDiagnosticEventPayload(
  event: BrewvaEventLike,
): SessionUncleanShutdownDiagnostic | null {
  return readBrewvaEventPayload(event, SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_DESCRIPTOR);
}
