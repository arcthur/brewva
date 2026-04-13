import { createHash } from "node:crypto";
import {
  MESSAGE_END_EVENT_TYPE,
  type BrewvaEventRecord,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
  THINKING_LEVEL_SELECTED_EVENT_TYPE,
  buildTranscriptMessagePayload,
  type StoredSessionMessage,
} from "../session/runtime-session-transcript.js";

type CustomMessageContentPart = { type: string };

const MODEL_SELECT_EVENT_TYPE = "model_select";

const HOSTED_SESSION_PROJECTION_MESSAGE_EVENT_TYPE = "hosted_session_projection_message";
const HOSTED_SESSION_PROJECTION_CUSTOM_MESSAGE_EVENT_TYPE =
  "hosted_session_projection_custom_message";
const HOSTED_SESSION_PROJECTION_THINKING_LEVEL_EVENT_TYPE =
  "hosted_session_projection_thinking_level_change";
const HOSTED_SESSION_PROJECTION_MODEL_EVENT_TYPE = "hosted_session_projection_model_change";
const HOSTED_SESSION_PROJECTION_BRANCH_SUMMARY_EVENT_TYPE =
  "hosted_session_projection_branch_summary";
const HOSTED_SESSION_PROJECTION_COMPACTION_EVENT_TYPE = "hosted_session_projection_compaction";

const LEGACY_PROJECTION_EVENT_TYPES = new Set<string>([
  HOSTED_SESSION_PROJECTION_MESSAGE_EVENT_TYPE,
  HOSTED_SESSION_PROJECTION_CUSTOM_MESSAGE_EVENT_TYPE,
  HOSTED_SESSION_PROJECTION_THINKING_LEVEL_EVENT_TYPE,
  HOSTED_SESSION_PROJECTION_MODEL_EVENT_TYPE,
  HOSTED_SESSION_PROJECTION_BRANCH_SUMMARY_EVENT_TYPE,
  HOSTED_SESSION_PROJECTION_COMPACTION_EVENT_TYPE,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProjectionMessage(value: unknown): value is StoredSessionMessage {
  return isRecord(value) && typeof value.role === "string" && typeof value.timestamp === "number";
}

function readProjectionCustomContent(
  value: unknown,
): string | CustomMessageContentPart[] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && typeof item.type === "string")
  ) {
    return value;
  }
  return undefined;
}

function normalizeParentId(payload: Record<string, unknown>): string | null {
  return readOptionalString(payload.parentId) ?? null;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function migrateLegacyProjectionEvent(
  runtime: BrewvaRuntime,
  sessionId: string,
  event: BrewvaEventRecord,
): boolean {
  const payload = isRecord(event.payload) ? event.payload : {};

  switch (event.type) {
    case HOSTED_SESSION_PROJECTION_MESSAGE_EVENT_TYPE: {
      const message = payload.message;
      if (!isProjectionMessage(message)) {
        return false;
      }
      return (
        recordRuntimeEvent(runtime, {
          sessionId,
          type: MESSAGE_END_EVENT_TYPE,
          payload: buildTranscriptMessagePayload(message),
        }) !== undefined
      );
    }
    case HOSTED_SESSION_PROJECTION_CUSTOM_MESSAGE_EVENT_TYPE: {
      const customType = readOptionalString(payload.customType);
      const content = readProjectionCustomContent(payload.content);
      if (!customType || content === undefined) {
        return false;
      }
      return (
        recordRuntimeEvent(runtime, {
          sessionId,
          type: MESSAGE_END_EVENT_TYPE,
          payload: buildTranscriptMessagePayload({
            role: "custom",
            customType,
            content,
            display: payload.display !== false,
            details: payload.details,
            timestamp: event.timestamp,
          }),
        }) !== undefined
      );
    }
    case HOSTED_SESSION_PROJECTION_THINKING_LEVEL_EVENT_TYPE: {
      const thinkingLevel = readOptionalString(payload.thinkingLevel);
      if (!thinkingLevel) {
        return false;
      }
      return (
        recordRuntimeEvent(runtime, {
          sessionId,
          type: THINKING_LEVEL_SELECTED_EVENT_TYPE,
          payload: { thinkingLevel },
        }) !== undefined
      );
    }
    case HOSTED_SESSION_PROJECTION_MODEL_EVENT_TYPE: {
      const provider = readOptionalString(payload.provider);
      const modelId = readOptionalString(payload.modelId);
      if (!provider || !modelId) {
        return false;
      }
      return (
        recordRuntimeEvent(runtime, {
          sessionId,
          type: MODEL_SELECT_EVENT_TYPE,
          payload: {
            provider,
            model: modelId,
            source: "legacy_projection_migration",
          },
        }) !== undefined
      );
    }
    case HOSTED_SESSION_PROJECTION_BRANCH_SUMMARY_EVENT_TYPE: {
      const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
      if (summary.length === 0) {
        return false;
      }
      return (
        recordRuntimeEvent(runtime, {
          sessionId,
          type: SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE,
          payload: {
            targetLeafEntryId: readOptionalString(payload.fromId) ?? null,
            summary,
            details: payload.details,
            replaceCurrent: false,
          },
        }) !== undefined
      );
    }
    case HOSTED_SESSION_PROJECTION_COMPACTION_EVENT_TYPE: {
      const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
      if (summary.length === 0) {
        return false;
      }
      runtime.authority.session.commitCompaction(sessionId, {
        compactId: event.id,
        sanitizedSummary: summary,
        summaryDigest: sha256(summary),
        sourceTurn: 0,
        leafEntryId: normalizeParentId(payload),
        referenceContextDigest: null,
        fromTokens: readOptionalNumber(payload.tokensBefore) ?? null,
        toTokens: null,
        origin: "hosted_recovery",
      });
      return true;
    }
    default:
      return false;
  }
}

export function hasLegacyHostedProjectionEvents(events: readonly BrewvaEventRecord[]): boolean {
  return events.some((event) => LEGACY_PROJECTION_EVENT_TYPES.has(event.type));
}

export function migrateLegacyHostedProjectionEvents(
  runtime: BrewvaRuntime,
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): number {
  let migrated = 0;
  for (const event of events) {
    if (!LEGACY_PROJECTION_EVENT_TYPES.has(event.type)) {
      continue;
    }
    if (migrateLegacyProjectionEvent(runtime, sessionId, event)) {
      migrated += 1;
    }
  }
  return migrated;
}
