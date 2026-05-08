import { asRecord, readString, readStringArray } from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
} from "../../events/descriptor-core.js";
import type { BrewvaEventLike } from "../../events/descriptor-core.js";
import {
  WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
} from "./events.js";

export {
  WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
  WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
} from "./events.js";

export interface WorkbenchNoteRecordedPayload {
  id: string;
  digest: string;
  content: string;
  sourceRefs: string[];
  reason: string;
  retentionHint?: string;
}

export interface WorkbenchEvictionRecordedPayload {
  id: string;
  digest: string;
  replacementNote: string;
  spanRefs: string[];
  reason: string;
  preservedQuotes: string[];
}

export interface WorkbenchEvictionUndonePayload {
  id: string;
  digest: string;
  reason?: string;
}

export interface WorkbenchBaselineCommittedPayload {
  entryIds: string[];
}

function readWorkbenchNoteRecordedPayload(payload: unknown): WorkbenchNoteRecordedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const id = readString(record.id);
  const digest = readString(record.digest);
  const content = readString(record.content);
  const reason = readString(record.reason);
  if (!id || !digest || !content || !reason) {
    return null;
  }
  const retentionHint = readString(record.retentionHint);
  return {
    id,
    digest,
    content,
    sourceRefs: readStringArray(record.sourceRefs),
    reason,
    ...(retentionHint ? { retentionHint } : {}),
  };
}

function readWorkbenchEvictionRecordedPayload(
  payload: unknown,
): WorkbenchEvictionRecordedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const id = readString(record.id);
  const digest = readString(record.digest);
  const reason = readString(record.reason);
  if (!id || !digest || !reason) {
    return null;
  }
  return {
    id,
    digest,
    replacementNote: typeof record.replacementNote === "string" ? record.replacementNote : "",
    spanRefs: readStringArray(record.spanRefs),
    reason,
    preservedQuotes: readStringArray(record.preservedQuotes),
  };
}

function readWorkbenchEvictionUndonePayload(
  payload: unknown,
): WorkbenchEvictionUndonePayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const id = readString(record.id);
  const digest = readString(record.digest);
  if (!id || !digest) {
    return null;
  }
  const reason = readString(record.reason);
  return {
    id,
    digest,
    ...(reason ? { reason } : {}),
  };
}

function readWorkbenchBaselineCommittedPayload(
  payload: unknown,
): WorkbenchBaselineCommittedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    entryIds: readStringArray(record.entryIds),
  };
}

export const WORKBENCH_NOTE_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: WORKBENCH_NOTE_RECORDED_EVENT_TYPE,
  category: "context",
  durability: "durable_evidence",
  readPayload: readWorkbenchNoteRecordedPayload,
});

export const WORKBENCH_EVICTION_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: WORKBENCH_EVICTION_RECORDED_EVENT_TYPE,
  category: "context",
  durability: "durable_evidence",
  readPayload: readWorkbenchEvictionRecordedPayload,
});

export const WORKBENCH_EVICTION_UNDONE_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: WORKBENCH_EVICTION_UNDONE_EVENT_TYPE,
  category: "context",
  durability: "durable_evidence",
  readPayload: readWorkbenchEvictionUndonePayload,
});

export const WORKBENCH_BASELINE_COMMITTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: WORKBENCH_BASELINE_COMMITTED_EVENT_TYPE,
  category: "session",
  durability: "durable_evidence",
  readPayload: readWorkbenchBaselineCommittedPayload,
});

export const WORKBENCH_EVENT_DESCRIPTORS = [
  WORKBENCH_NOTE_RECORDED_EVENT_DESCRIPTOR,
  WORKBENCH_EVICTION_RECORDED_EVENT_DESCRIPTOR,
  WORKBENCH_EVICTION_UNDONE_EVENT_DESCRIPTOR,
  WORKBENCH_BASELINE_COMMITTED_EVENT_DESCRIPTOR,
] as const;

export function readWorkbenchNoteRecordedEventPayload(
  event: BrewvaEventLike,
): WorkbenchNoteRecordedPayload | null {
  return readBrewvaEventPayload(event, WORKBENCH_NOTE_RECORDED_EVENT_DESCRIPTOR);
}

export function readWorkbenchEvictionRecordedEventPayload(
  event: BrewvaEventLike,
): WorkbenchEvictionRecordedPayload | null {
  return readBrewvaEventPayload(event, WORKBENCH_EVICTION_RECORDED_EVENT_DESCRIPTOR);
}

export function readWorkbenchEvictionUndoneEventPayload(
  event: BrewvaEventLike,
): WorkbenchEvictionUndonePayload | null {
  return readBrewvaEventPayload(event, WORKBENCH_EVICTION_UNDONE_EVENT_DESCRIPTOR);
}

export function readWorkbenchBaselineCommittedEventPayload(
  event: BrewvaEventLike,
): WorkbenchBaselineCommittedPayload | null {
  return readBrewvaEventPayload(event, WORKBENCH_BASELINE_COMMITTED_EVENT_DESCRIPTOR);
}
