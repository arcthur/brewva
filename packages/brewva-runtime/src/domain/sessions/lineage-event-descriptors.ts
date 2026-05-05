import {
  asRecord,
  readJsonRecord,
  readNullableString,
  readString,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import {
  CAPABILITY_STATE_RECORDED_EVENT_TYPE,
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
} from "./events.js";
import type {
  CapabilityStateRecordedPayload,
  ContextAdmission,
  ContextEntryPresentTo,
  ContextEntryRecordedPayload,
  ForkPoint,
  LineageOutcomeAdmission,
  SessionLineageNodeCreatedPayload,
  SessionLineageOutcomeAdoptedPayload,
  SessionLineageOutcomeRecordedPayload,
  SessionLineageSelectionRecordedPayload,
  SessionLineageSummaryRecordedPayload,
} from "./lineage.js";

export {
  CAPABILITY_STATE_RECORDED_EVENT_TYPE,
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
  SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
  SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
} from "./events.js";

function readSchema(record: Record<string, unknown>, schema: string): string | null {
  return record.schema === schema ? schema : null;
}

function readOptionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : (readString(value) ?? undefined);
}

function readOptionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return readNullableString(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function readStrictStringField(record: Record<string, unknown>, key: string): string | null {
  return Object.hasOwn(record, key) ? readString(record[key]) : null;
}

function readForkPoint(value: unknown): ForkPoint | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = readString(record.kind);
  if (!kind) return null;

  switch (kind) {
    case "session_root": {
      if (!hasOnlyKeys(record, ["kind", "parentSessionId"])) return null;
      const parentSessionId = readOptionalString(record.parentSessionId);
      if (record.parentSessionId !== undefined && parentSessionId === undefined) return null;
      return parentSessionId ? { kind, parentSessionId } : { kind };
    }
    case "reasoning_checkpoint": {
      if (!hasOnlyKeys(record, ["kind", "reasoningCheckpointId"])) return null;
      const reasoningCheckpointId = readStrictStringField(record, "reasoningCheckpointId");
      return reasoningCheckpointId ? { kind, reasoningCheckpointId } : null;
    }
    case "turn": {
      if (!hasOnlyKeys(record, ["kind", "turnId"])) return null;
      const turnId = readStrictStringField(record, "turnId");
      return turnId ? { kind, turnId } : null;
    }
    case "context_entry": {
      if (!hasOnlyKeys(record, ["kind", "lineageNodeId", "entryId"])) return null;
      const lineageNodeId = readStrictStringField(record, "lineageNodeId");
      const entryId = readStrictStringField(record, "entryId");
      return lineageNodeId && entryId ? { kind, lineageNodeId, entryId } : null;
    }
    case "tool_call": {
      if (!hasOnlyKeys(record, ["kind", "toolCallId"])) return null;
      const toolCallId = readStrictStringField(record, "toolCallId");
      return toolCallId ? { kind, toolCallId } : null;
    }
    case "patch_set": {
      if (!hasOnlyKeys(record, ["kind", "patchSetId"])) return null;
      const patchSetId = readStrictStringField(record, "patchSetId");
      return patchSetId ? { kind, patchSetId } : null;
    }
    case "worker_run": {
      if (!hasOnlyKeys(record, ["kind", "workerRunId"])) return null;
      const workerRunId = readStrictStringField(record, "workerRunId");
      return workerRunId ? { kind, workerRunId } : null;
    }
    default:
      return null;
  }
}

function isContextAdmission(value: unknown): value is ContextAdmission {
  return value === "state_only" || value === "context_eligible" || value === "context_required";
}

function isLineageOutcomeAdmission(value: unknown): value is LineageOutcomeAdmission {
  return value === "state_only" || value === "context_eligible";
}

function isContextEntryPresentTo(value: unknown): value is ContextEntryPresentTo {
  return value === "llm" || value === "ui" || value === "both";
}

function readSessionLineageNodeCreatedPayload(
  payload: unknown,
): SessionLineageNodeCreatedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE)) return null;
  const lineageNodeId = readString(record.lineageNodeId);
  const parentLineageNodeId = readOptionalNullableString(record.parentLineageNodeId) ?? null;
  const kind = readString(record.kind);
  const forkPoint = readForkPoint(record.forkPoint);
  if (!lineageNodeId || !kind || !forkPoint) return null;
  const title = readOptionalString(record.title);
  const createdBy = readOptionalString(record.createdBy);
  return {
    schema: SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
    lineageNodeId,
    parentLineageNodeId,
    kind,
    forkPoint,
    ...(title ? { title } : {}),
    ...(createdBy ? { createdBy } : {}),
  };
}

function readSessionLineageSummaryRecordedPayload(
  payload: unknown,
): SessionLineageSummaryRecordedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE)) return null;
  const summaryId = readString(record.summaryId);
  const lineageNodeId = readString(record.lineageNodeId);
  const attachToEntryId = readOptionalNullableString(record.attachToEntryId) ?? null;
  const summary = readString(record.summary);
  const admission = record.admission;
  if (!summaryId || !lineageNodeId || !summary || !isContextAdmission(admission)) return null;
  const detailsArtifactRef = readOptionalString(record.detailsArtifactRef);
  return {
    schema: SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
    summaryId,
    lineageNodeId,
    attachToEntryId,
    summary,
    admission,
    ...(detailsArtifactRef ? { detailsArtifactRef } : {}),
  };
}

function readSessionLineageOutcomeRecordedPayload(
  payload: unknown,
): SessionLineageOutcomeRecordedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE)) return null;
  const outcomeId = readString(record.outcomeId);
  const lineageNodeId = readString(record.lineageNodeId);
  const summary = readString(record.summary);
  const admission = record.admission;
  if (!outcomeId || !lineageNodeId || !summary || !isLineageOutcomeAdmission(admission)) {
    return null;
  }
  const outcomeRef = readOptionalString(record.outcomeRef);
  const detailsArtifactRef = readOptionalString(record.detailsArtifactRef);
  return {
    schema: SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
    outcomeId,
    lineageNodeId,
    summary,
    admission,
    ...(outcomeRef ? { outcomeRef } : {}),
    ...(detailsArtifactRef ? { detailsArtifactRef } : {}),
  };
}

function readSessionLineageOutcomeAdoptedPayload(
  payload: unknown,
): SessionLineageOutcomeAdoptedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE)) return null;
  const adoptionId = readString(record.adoptionId);
  const outcomeId = readString(record.outcomeId);
  const fromLineageNodeId = readString(record.fromLineageNodeId);
  const toLineageNodeId = readString(record.toLineageNodeId);
  const admission = record.admission;
  if (
    !adoptionId ||
    !outcomeId ||
    !fromLineageNodeId ||
    !toLineageNodeId ||
    !isContextAdmission(admission)
  ) {
    return null;
  }
  const summary = readOptionalString(record.summary);
  const adoptedEntryId = readOptionalString(record.adoptedEntryId);
  return {
    schema: SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
    adoptionId,
    outcomeId,
    fromLineageNodeId,
    toLineageNodeId,
    admission,
    ...(summary ? { summary } : {}),
    ...(adoptedEntryId ? { adoptedEntryId } : {}),
  };
}

function readSessionLineageSelectionRecordedPayload(
  payload: unknown,
): SessionLineageSelectionRecordedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE)) return null;
  const selectionId = readString(record.selectionId);
  const channelId = readString(record.channelId);
  const lineageNodeId = readString(record.lineageNodeId);
  if (!selectionId || !channelId || !lineageNodeId) return null;
  const previousLineageNodeId = readOptionalString(record.previousLineageNodeId);
  const reason = readOptionalString(record.reason);
  return {
    schema: SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
    selectionId,
    channelId,
    lineageNodeId,
    ...(previousLineageNodeId ? { previousLineageNodeId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function readContextEntryRecordedPayload(payload: unknown): ContextEntryRecordedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, CONTEXT_ENTRY_RECORDED_EVENT_TYPE)) return null;
  const entryId = readString(record.entryId);
  const lineageNodeId = readString(record.lineageNodeId);
  const parentEntryId = readOptionalNullableString(record.parentEntryId) ?? null;
  const sourceEventId = readString(record.sourceEventId);
  const sourceEventType = readString(record.sourceEventType);
  const entryKind = readString(record.entryKind);
  const admission = record.admission;
  const presentTo = record.presentTo;
  if (
    !entryId ||
    !lineageNodeId ||
    !sourceEventId ||
    !sourceEventType ||
    !entryKind ||
    !isContextAdmission(admission) ||
    !isContextEntryPresentTo(presentTo)
  ) {
    return null;
  }
  const attachToEntryId = readOptionalNullableString(record.attachToEntryId) ?? undefined;
  const contentRef = readOptionalString(record.contentRef);
  return {
    schema: CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
    entryId,
    lineageNodeId,
    parentEntryId,
    sourceEventId,
    sourceEventType,
    entryKind,
    admission,
    presentTo,
    ...(attachToEntryId !== undefined ? { attachToEntryId } : {}),
    ...(contentRef ? { contentRef } : {}),
  };
}

function readCapabilityStateRecordedPayload(
  payload: unknown,
): CapabilityStateRecordedPayload | null {
  const record = asRecord(payload);
  if (!record || !readSchema(record, CAPABILITY_STATE_RECORDED_EVENT_TYPE)) return null;
  const stateId = readString(record.stateId);
  const ownerCapability = readString(record.ownerCapability);
  const customType = readString(record.customType);
  const data = readJsonRecord(record.data);
  if (!stateId || !ownerCapability || !customType || !data) return null;
  const artifactRef = readOptionalString(record.artifactRef);
  const lineageNodeId = readOptionalString(record.lineageNodeId);
  const entryId = readOptionalString(record.entryId);
  return {
    schema: CAPABILITY_STATE_RECORDED_EVENT_TYPE,
    stateId,
    ownerCapability,
    customType,
    data,
    ...(artifactRef ? { artifactRef } : {}),
    ...(lineageNodeId ? { lineageNodeId } : {}),
    ...(entryId ? { entryId } : {}),
  };
}

export const SESSION_LINEAGE_NODE_CREATED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_LINEAGE_NODE_CREATED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionLineageNodeCreatedPayload,
});

export const SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionLineageSummaryRecordedPayload,
});

export const SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionLineageOutcomeRecordedPayload,
});

export const SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionLineageOutcomeAdoptedPayload,
});

export const SESSION_LINEAGE_SELECTION_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SESSION_LINEAGE_SELECTION_RECORDED_EVENT_TYPE,
  category: "session",
  durability: "source_of_truth",
  readPayload: readSessionLineageSelectionRecordedPayload,
});

export const CONTEXT_ENTRY_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  category: "context",
  durability: "source_of_truth",
  readPayload: readContextEntryRecordedPayload,
});

export const CAPABILITY_STATE_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: CAPABILITY_STATE_RECORDED_EVENT_TYPE,
  category: "state",
  durability: "source_of_truth",
  readPayload: readCapabilityStateRecordedPayload,
});

export const SESSION_LINEAGE_EVENT_DESCRIPTORS = [
  SESSION_LINEAGE_NODE_CREATED_EVENT_DESCRIPTOR,
  SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_DESCRIPTOR,
  SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_DESCRIPTOR,
  SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_DESCRIPTOR,
  SESSION_LINEAGE_SELECTION_RECORDED_EVENT_DESCRIPTOR,
  CONTEXT_ENTRY_RECORDED_EVENT_DESCRIPTOR,
  CAPABILITY_STATE_RECORDED_EVENT_DESCRIPTOR,
] as const;

export const readSessionLineageNodeCreatedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, SESSION_LINEAGE_NODE_CREATED_EVENT_DESCRIPTOR);
export const readSessionLineageSummaryRecordedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, SESSION_LINEAGE_SUMMARY_RECORDED_EVENT_DESCRIPTOR);
export const readSessionLineageOutcomeRecordedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, SESSION_LINEAGE_OUTCOME_RECORDED_EVENT_DESCRIPTOR);
export const readSessionLineageOutcomeAdoptedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, SESSION_LINEAGE_OUTCOME_ADOPTED_EVENT_DESCRIPTOR);
export const readSessionLineageSelectionRecordedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, SESSION_LINEAGE_SELECTION_RECORDED_EVENT_DESCRIPTOR);
export const readContextEntryRecordedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, CONTEXT_ENTRY_RECORDED_EVENT_DESCRIPTOR);
export const readCapabilityStateRecordedEventPayload = (event: BrewvaEventLike) =>
  readBrewvaEventPayload(event, CAPABILITY_STATE_RECORDED_EVENT_DESCRIPTOR);
