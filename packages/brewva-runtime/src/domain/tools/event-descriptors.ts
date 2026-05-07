import { toJsonValue } from "@brewva/brewva-std/json";
import { asBrewvaToolCallId, asBrewvaToolName } from "../../core/identifiers.js";
import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  asRecord,
  readJsonRecord,
  readNonNegativeNumber,
  readString,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import type {
  ToolCallBlockedEventPayload,
  ToolLifecycleEventPayload,
  ToolOutputDistilledEventPayload,
  ToolResultFailureClass,
  ToolResultFailureContextPayload,
  ToolResultRecordedEventPayload,
} from "./api.js";
import {
  BOX_ACQUIRED_EVENT_TYPE,
  BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
  BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
  BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
  BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
  BOX_EXEC_COMPLETED_EVENT_TYPE,
  BOX_EXEC_FAILED_EVENT_TYPE,
  BOX_EXEC_STARTED_EVENT_TYPE,
  BOX_FORK_CREATED_EVENT_TYPE,
  BOX_MAINTENANCE_COMPLETED_EVENT_TYPE,
  BOX_RELEASED_EVENT_TYPE,
  BOX_SNAPSHOT_CREATED_EVENT_TYPE,
  TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_CALL_MARKED_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
  TOOL_OUTPUT_SEARCH_EVENT_TYPE,
  TOOL_PARALLEL_READ_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
} from "./events.js";

export {
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "./events.js";

function readCanonicalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function readRequiredBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readCanonicalNonNegativeInteger(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    return null;
  }
  return value;
}

function isToolResultVerdict(value: unknown): value is ToolResultRecordedEventPayload["verdict"] {
  return value === "pass" || value === "fail" || value === "inconclusive";
}

function isToolResultFailureClass(value: unknown): value is ToolResultFailureClass {
  return (
    value === "execution" ||
    value === "invocation_validation" ||
    value === "policy_denied" ||
    value === "shell_syntax" ||
    value === "script_composition"
  );
}

function readToolLifecycleEventPayloadValue(payload: unknown): ToolLifecycleEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const toolCallId = readString(record.toolCallId);
  const toolName = readString(record.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }
  const attempt = record.attempt === null ? null : readNonNegativeNumber(record.attempt);
  if (record.attempt !== undefined && record.attempt !== null && attempt === null) {
    return null;
  }
  const executionTraits =
    record.executionTraits === null || record.executionTraits === undefined
      ? (record.executionTraits ?? undefined)
      : toJsonValue(record.executionTraits);
  return {
    toolCallId,
    toolName,
    ...(record.attempt !== undefined ? { attempt: attempt ?? null } : {}),
    ...(typeof record.isError === "boolean" ? { isError: record.isError } : {}),
    ...(readString(record.terminalReason)
      ? { terminalReason: readString(record.terminalReason)! }
      : {}),
    ...(readString(record.lifecycleFallbackReason)
      ? { lifecycleFallbackReason: readString(record.lifecycleFallbackReason)! }
      : {}),
    ...(executionTraits !== undefined ? { executionTraits } : {}),
  };
}

function readToolResultFailureContextPayloadValue(
  value: unknown,
): ToolResultFailureContextPayload | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const args = readJsonRecord(record.args) ?? {};
  const outputText = readString(record.outputText);
  const turn = readNonNegativeNumber(record.turn);
  if (!outputText || turn === null) {
    return null;
  }
  return {
    args,
    outputText,
    failureClass: isToolResultFailureClass(record.failureClass) ? record.failureClass : null,
    turn,
  };
}

function readToolResultRecordedEventPayloadValue(
  payload: unknown,
): ToolResultRecordedEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const toolName = readString(record.toolName);
  const normalizedToolName = toolName ? normalizeToolName(toolName) : "";
  const toolCallId = readString(record.toolCallId);
  const verdict = record.verdict;
  const channelSuccess = readRequiredBoolean(record.channelSuccess);
  const ledgerId = readString(record.ledgerId);
  if (
    !normalizedToolName ||
    !ledgerId ||
    !isToolResultVerdict(verdict) ||
    channelSuccess === null
  ) {
    return null;
  }
  return {
    toolName: asBrewvaToolName(normalizedToolName),
    toolCallId: toolCallId ? asBrewvaToolCallId(toolCallId) : null,
    verdict,
    channelSuccess,
    ledgerId,
    effectCommitmentRequestId: readString(record.effectCommitmentRequestId),
    outputObservation: readJsonRecord(record.outputObservation) ?? null,
    outputArtifact: readJsonRecord(record.outputArtifact) ?? null,
    outputDistillation: readJsonRecord(record.outputDistillation) ?? null,
    truthProjection: readJsonRecord(record.truthProjection) ?? null,
    verificationProjection: readJsonRecord(record.verificationProjection) ?? null,
    failureClass: isToolResultFailureClass(record.failureClass) ? record.failureClass : null,
    failureContext: readToolResultFailureContextPayloadValue(record.failureContext),
  };
}

function readToolOutputDistilledEventPayloadValue(
  payload: unknown,
): ToolOutputDistilledEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const toolName = readCanonicalString(record.toolName);
  const normalizedToolName = toolName && normalizeToolName(toolName) === toolName ? toolName : null;
  const toolCallId =
    record.toolCallId === undefined
      ? null
      : record.toolCallId === null
        ? null
        : readCanonicalString(record.toolCallId);
  const strategy = readCanonicalString(record.strategy);
  const rawChars = readCanonicalNonNegativeInteger(record.rawChars);
  const rawBytes = readCanonicalNonNegativeInteger(record.rawBytes);
  const rawTokens =
    record.rawTokens === undefined || record.rawTokens === null
      ? null
      : readCanonicalNonNegativeInteger(record.rawTokens);
  const summaryChars = readCanonicalNonNegativeInteger(record.summaryChars);
  const summaryBytes = readCanonicalNonNegativeInteger(record.summaryBytes);
  const summaryTokens =
    record.summaryTokens === undefined || record.summaryTokens === null
      ? null
      : readCanonicalNonNegativeInteger(record.summaryTokens);
  const compressionRatio =
    record.compressionRatio === undefined || record.compressionRatio === null
      ? null
      : typeof record.compressionRatio === "number" &&
          Number.isFinite(record.compressionRatio) &&
          record.compressionRatio >= 0 &&
          record.compressionRatio <= 1
        ? record.compressionRatio
        : null;
  const isError = readRequiredBoolean(record.isError);
  const truncated = readRequiredBoolean(record.truncated);
  if (
    !normalizedToolName ||
    (record.toolCallId !== undefined && record.toolCallId !== null && toolCallId === null) ||
    !strategy ||
    rawChars === null ||
    rawBytes === null ||
    (record.rawTokens !== undefined && record.rawTokens !== null && rawTokens === null) ||
    summaryChars === null ||
    summaryBytes === null ||
    (record.summaryTokens !== undefined &&
      record.summaryTokens !== null &&
      summaryTokens === null) ||
    (record.compressionRatio !== undefined &&
      record.compressionRatio !== null &&
      compressionRatio === null) ||
    isError === null ||
    truncated === null ||
    typeof record.summaryText !== "string"
  ) {
    return null;
  }

  const verdict =
    record.verdict === undefined || record.verdict === null
      ? null
      : isToolResultVerdict(record.verdict)
        ? record.verdict
        : null;
  if (record.verdict !== undefined && record.verdict !== null && verdict === null) {
    return null;
  }
  const artifactRef =
    record.artifactRef === undefined
      ? null
      : record.artifactRef === null
        ? null
        : readCanonicalString(record.artifactRef);
  if (record.artifactRef !== undefined && record.artifactRef !== null && artifactRef === null) {
    return null;
  }

  return {
    toolCallId: toolCallId ? asBrewvaToolCallId(toolCallId) : null,
    toolName: asBrewvaToolName(normalizedToolName),
    isError,
    verdict,
    strategy,
    rawChars,
    rawBytes,
    rawTokens,
    summaryChars,
    summaryBytes,
    summaryTokens,
    compressionRatio,
    truncated,
    summaryText: record.summaryText,
    artifactRef,
  };
}

function readToolCallBlockedEventPayloadValue(
  payload: unknown,
): ToolCallBlockedEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const schema = record.schema;
  const toolName = readString(record.toolName);
  const reason = readString(record.reason);
  if (schema !== "brewva.tool_call_blocked.v1" || !toolName || !reason) {
    return null;
  }
  return {
    schema,
    toolName,
    reason,
    decision: readString(record.decision),
    proposalId: readString(record.proposalId),
    requestId: readString(record.requestId),
    manifestBasis: (record.manifestBasis as ToolCallBlockedEventPayload["manifestBasis"]) ?? null,
    ...(Object.prototype.hasOwnProperty.call(record, "skill")
      ? { skill: readString(record.skill) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "resolution")
      ? { resolution: readString(record.resolution) }
      : {}),
  };
}

export const TOOL_CALL_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_CALL_EVENT_TYPE,
  category: "tool",
  durability: "source_of_truth",
  readPayload: readToolLifecycleEventPayloadValue,
});

export const TOOL_EXECUTION_START_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_EXECUTION_START_EVENT_TYPE,
  category: "tool",
  durability: "source_of_truth",
  readPayload: readToolLifecycleEventPayloadValue,
});

export const TOOL_EXECUTION_END_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_EXECUTION_END_EVENT_TYPE,
  category: "tool",
  durability: "source_of_truth",
  readPayload: readToolLifecycleEventPayloadValue,
});

export const TOOL_RESULT_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_RESULT_RECORDED_EVENT_TYPE,
  category: "tool",
  durability: "source_of_truth",
  readPayload: readToolResultRecordedEventPayloadValue,
});

export const TOOL_OUTPUT_DISTILLED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_OUTPUT_DISTILLED_EVENT_TYPE,
  category: "tool",
  durability: "rebuildable_signal",
  readPayload: readToolOutputDistilledEventPayloadValue,
});

export const TOOL_CALL_BLOCKED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TOOL_CALL_BLOCKED_EVENT_TYPE,
  category: "tool",
  durability: "durable_evidence",
  readPayload: readToolCallBlockedEventPayloadValue,
});

export const TOOLS_EVENT_DESCRIPTORS = [
  TOOL_CALL_EVENT_DESCRIPTOR,
  TOOL_EXECUTION_START_EVENT_DESCRIPTOR,
  TOOL_EXECUTION_END_EVENT_DESCRIPTOR,
  TOOL_RESULT_RECORDED_EVENT_DESCRIPTOR,
  TOOL_OUTPUT_DISTILLED_EVENT_DESCRIPTOR,
  TOOL_CALL_BLOCKED_EVENT_DESCRIPTOR,
] as const;

export function readToolLifecycleEventPayload(
  event: BrewvaEventLike,
): ToolLifecycleEventPayload | null {
  switch (event.type) {
    case TOOL_CALL_EVENT_TYPE:
      return readBrewvaEventPayload(event, TOOL_CALL_EVENT_DESCRIPTOR);
    case TOOL_EXECUTION_START_EVENT_TYPE:
      return readBrewvaEventPayload(event, TOOL_EXECUTION_START_EVENT_DESCRIPTOR);
    case TOOL_EXECUTION_END_EVENT_TYPE:
      return readBrewvaEventPayload(event, TOOL_EXECUTION_END_EVENT_DESCRIPTOR);
    default:
      return null;
  }
}

export function readToolResultRecordedEventPayload(
  event: BrewvaEventLike,
): ToolResultRecordedEventPayload | null {
  return readBrewvaEventPayload(event, TOOL_RESULT_RECORDED_EVENT_DESCRIPTOR);
}

export function readToolOutputDistilledEventPayload(
  event: BrewvaEventLike,
): ToolOutputDistilledEventPayload | null {
  return readBrewvaEventPayload(event, TOOL_OUTPUT_DISTILLED_EVENT_DESCRIPTOR);
}

export function readToolCallBlockedEventPayload(
  event: BrewvaEventLike,
): ToolCallBlockedEventPayload | null {
  return readBrewvaEventPayload(event, TOOL_CALL_BLOCKED_EVENT_DESCRIPTOR);
}

export const TOOLS_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: BOX_ACQUIRED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_EXEC_COMPLETED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_EXEC_FAILED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_EXEC_STARTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_FORK_CREATED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_MAINTENANCE_COMPLETED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_RELEASED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: BOX_SNAPSHOT_CREATED_EVENT_TYPE,
    category: "state",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_CALL_MARKED_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_CONTRACT_WARNING_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_OUTPUT_ARTIFACT_PERSIST_FAILED_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_OUTPUT_OBSERVED_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_OUTPUT_SEARCH_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_PARALLEL_READ_EVENT_TYPE,
    category: "tool",
    durability: "session_local",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_SURFACE_RESOLVED_EVENT_TYPE,
    category: "tool",
    durability: "rebuildable_signal",
  }),
] as const;
