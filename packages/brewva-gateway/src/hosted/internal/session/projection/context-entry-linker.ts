import type { ContextAdmission, ContextEntryPresentTo } from "@brewva/brewva-runtime";
import {
  type BrewvaEventRecord,
  CONTEXT_ENTRY_RECORDED_EVENT_TYPE,
  MESSAGE_END_EVENT_TYPE,
  readSessionRewindCompletedEventPayload,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { isRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import {
  SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
  readTranscriptMessageFromPayload,
  type StoredSessionMessage,
} from "../../thread-loop/runtime-session-transcript.js";

const SESSION_COMPACT_EVENT_TYPE = "session_compact";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readCanonicalCompactionPayload(payload: unknown): {
  compactId: string;
  sanitizedSummary: string;
  sourceTurn: number;
  leafEntryId: string | null;
  referenceContextDigest: string | null;
  fromTokens: number | null;
  toTokens: number | null;
  origin: string;
  summaryDigest: string;
  summaryGeneration?: unknown;
  integrityViolations?: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const compactId = readOptionalString(payload.compactId);
  const sanitizedSummary =
    typeof payload.sanitizedSummary === "string" ? payload.sanitizedSummary : "";
  const sourceTurn = readFiniteNumberValue(payload.sourceTurn);
  const origin = readOptionalString(payload.origin);
  const summaryDigest = readOptionalString(payload.summaryDigest);
  if (!compactId || sourceTurn === undefined || !origin || !summaryDigest) {
    return null;
  }
  if (summaryDigest !== sha256Hex(sanitizedSummary)) {
    return null;
  }
  return {
    compactId,
    sanitizedSummary,
    sourceTurn,
    leafEntryId:
      payload.leafEntryId === null ? null : (readOptionalString(payload.leafEntryId) ?? null),
    referenceContextDigest:
      payload.referenceContextDigest === null
        ? null
        : (readOptionalString(payload.referenceContextDigest) ?? null),
    fromTokens:
      typeof payload.fromTokens === "number" && Number.isFinite(payload.fromTokens)
        ? payload.fromTokens
        : null,
    toTokens:
      typeof payload.toTokens === "number" && Number.isFinite(payload.toTokens)
        ? payload.toTokens
        : null,
    origin,
    summaryDigest,
    summaryGeneration: payload.summaryGeneration,
    integrityViolations: payload.integrityViolations,
  };
}

export function readBranchSummaryPayload(payload: unknown): {
  summary: string;
  targetLeafEntryId: string | null;
  fromId: string | null;
  details?: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  const summary = typeof payload.summary === "string" ? payload.summary : "";
  if (summary.trim().length === 0) {
    return null;
  }
  return {
    summary,
    targetLeafEntryId:
      payload.targetLeafEntryId === null
        ? null
        : (readOptionalString(payload.targetLeafEntryId) ?? null),
    fromId: payload.fromId === null ? null : (readOptionalString(payload.fromId) ?? null),
    details: payload.details,
  };
}

function resolveMessageAdmission(
  message: StoredSessionMessage & { excludeFromContext?: unknown; display?: unknown },
): ContextAdmission {
  if (message.excludeFromContext === true) {
    return "state_only";
  }
  if (message.role === "custom" && message.display === false) {
    return "context_eligible";
  }
  return "context_required";
}

function resolveMessagePresentation(
  message: StoredSessionMessage & { excludeFromContext?: unknown; display?: unknown },
): ContextEntryPresentTo {
  if (message.excludeFromContext === true) {
    return "ui";
  }
  if (message.role === "custom" && message.display === false) {
    return "llm";
  }
  return "both";
}

export function isContextSourceEvent(event: BrewvaEventRecord): boolean {
  if (
    event.type === MESSAGE_END_EVENT_TYPE ||
    event.type === SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE ||
    event.type === SESSION_COMPACT_EVENT_TYPE
  ) {
    return true;
  }
  if (event.type !== SESSION_REWIND_COMPLETED_EVENT_TYPE) {
    return false;
  }
  const rewind = readSessionRewindCompletedEventPayload(event);
  return rewind?.ok === true && rewind.divergenceNote !== undefined;
}

export function resolveContextEntryInputForSourceEvent(input: {
  sourceEvent: BrewvaEventRecord;
  currentLeafId: string | null;
}): {
  entryKind: string;
  admission: ContextAdmission;
  presentTo: ContextEntryPresentTo;
  parentEntryId: string | null;
} | null {
  const payload = isRecord(input.sourceEvent.payload) ? input.sourceEvent.payload : {};
  if (input.sourceEvent.type === MESSAGE_END_EVENT_TYPE) {
    const message = readTranscriptMessageFromPayload(payload);
    if (!message) {
      return null;
    }
    return {
      entryKind: "message",
      admission: resolveMessageAdmission(message),
      presentTo: resolveMessagePresentation(message),
      parentEntryId: input.currentLeafId,
    };
  }
  if (input.sourceEvent.type === SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE) {
    const branchSummary = readBranchSummaryPayload(payload);
    if (!branchSummary) {
      return null;
    }
    return {
      entryKind: "branch_summary",
      admission: "context_eligible",
      presentTo: "llm",
      parentEntryId: branchSummary.targetLeafEntryId,
    };
  }
  if (input.sourceEvent.type === SESSION_COMPACT_EVENT_TYPE) {
    const compaction = readCanonicalCompactionPayload(payload);
    if (!compaction) {
      return null;
    }
    return {
      entryKind: "compaction",
      admission: "context_required",
      presentTo: "llm",
      parentEntryId: compaction.leafEntryId ?? input.currentLeafId,
    };
  }
  if (input.sourceEvent.type === SESSION_REWIND_COMPLETED_EVENT_TYPE) {
    const rewind = readSessionRewindCompletedEventPayload(input.sourceEvent);
    if (!rewind?.ok || !rewind.divergenceNote) {
      return null;
    }
    return {
      entryKind: "branch_summary",
      admission: "context_required",
      presentTo: "llm",
      parentEntryId: input.currentLeafId,
    };
  }
  return null;
}

export function isContextEntryRecordedEvent(event: BrewvaEventRecord): boolean {
  return event.type === CONTEXT_ENTRY_RECORDED_EVENT_TYPE;
}
