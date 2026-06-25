import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "./wire.js";

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return readNonEmptyString(value) !== undefined;
}

function isSource(value: unknown): value is SessionWireFrame["source"] {
  return value === "live" || value === "replay";
}

function isDurability(value: unknown): value is SessionWireFrame["durability"] {
  return value === "cache" || value === "durable";
}

function isContextStatus(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    readFiniteNumberValue(value.tokensUsed) !== undefined &&
    readFiniteNumberValue(value.tokensTotal) !== undefined &&
    readFiniteNumberValue(value.tokensRemaining) !== undefined &&
    readFiniteNumberValue(value.tokensUntilForcedCompact) !== undefined &&
    readFiniteNumberValue(value.predictedTurnGrowthTokens) !== undefined &&
    readFiniteNumberValue(value.tokensUntilPredictedOverflow) !== undefined &&
    typeof value.predictedOverflow === "boolean" &&
    readFiniteNumberValue(value.usageRatio) !== undefined &&
    readFiniteNumberValue(value.hardLimitRatio) !== undefined &&
    readFiniteNumberValue(value.compactionThresholdRatio) !== undefined &&
    typeof value.compactionAdvised === "boolean" &&
    typeof value.forcedCompaction === "boolean"
  );
}

function isToolOutputDisplayView(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    isOptionalString(value.summaryText) &&
    isOptionalString(value.detailsText) &&
    isOptionalString(value.rawText)
  );
}

function isToolOutputView(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isNonEmptyString(value.verdict) &&
    typeof value.isError === "boolean" &&
    typeof value.text === "string" &&
    (value.ts === undefined || readFiniteNumberValue(value.ts) !== undefined) &&
    (value.sequence === undefined || readFiniteNumberValue(value.sequence) !== undefined) &&
    isOptionalString(value.sourceEventId) &&
    isToolOutputDisplayView(value.display)
  );
}

function isAssistantTextSegmentView(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.text === "string" &&
    readFiniteNumberValue(value.ts) !== undefined &&
    (value.sequence === undefined || readFiniteNumberValue(value.sequence) !== undefined) &&
    isOptionalString(value.sourceEventId)
  );
}

function isAssistantTextSegmentList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isAssistantTextSegmentView));
}

function hasSessionWireBase(value: Record<string, unknown>): string | null {
  if (value.schema !== SESSION_WIRE_SCHEMA) {
    return `schema must be ${SESSION_WIRE_SCHEMA}`;
  }
  if (!isNonEmptyString(value.sessionId)) {
    return "sessionId must be a non-empty string";
  }
  if (!isNonEmptyString(value.frameId)) {
    return "frameId must be a non-empty string";
  }
  if (readFiniteNumberValue(value.ts) === undefined) {
    return "ts must be a finite number";
  }
  if (!isSource(value.source)) {
    return "source must be 'live' or 'replay'";
  }
  if (!isDurability(value.durability)) {
    return "durability must be 'cache' or 'durable'";
  }
  if (!isOptionalString(value.sourceEventId)) {
    return "sourceEventId must be a string when present";
  }
  if (!isOptionalString(value.sourceEventType)) {
    return "sourceEventType must be a string when present";
  }
  if (!isNonEmptyString(value.type)) {
    return "type must be a non-empty string";
  }
  return null;
}

function hasSourceProvenance(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.sourceEventId) && isNonEmptyString(value.sourceEventType);
}

function hasAnySourceProvenance(value: Record<string, unknown>): boolean {
  return value.sourceEventId !== undefined || value.sourceEventType !== undefined;
}

function requireReplayControlSemantics(
  value: Record<string, unknown>,
  type: string,
): string | null {
  if (value.source !== "replay" || value.durability !== "cache") {
    return `${type} must be a replay cache control frame`;
  }
  if (hasAnySourceProvenance(value)) {
    return `${type} must not carry source provenance`;
  }
  return null;
}

function requireLiveCacheSemantics(value: Record<string, unknown>, type: string): string | null {
  if (value.source !== "live" || value.durability !== "cache") {
    return `${type} must be a live cache frame`;
  }
  if (hasAnySourceProvenance(value)) {
    return `${type} must not carry source provenance`;
  }
  return null;
}

function requireDurableSemantics(value: Record<string, unknown>, type: string): string | null {
  if (value.durability !== "durable") {
    return `${type} must be durable`;
  }
  if (!hasSourceProvenance(value)) {
    return `${type} durable frames require sourceEventId and sourceEventType`;
  }
  return null;
}

function asSessionWireFrame(value: Record<string, unknown>): SessionWireFrame {
  return value as unknown as SessionWireFrame;
}

export function validateSessionWireFramePayload(
  value: unknown,
): { ok: true; frame: SessionWireFrame } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "session wire frame must be an object" };
  }
  const baseError = hasSessionWireBase(value);
  if (baseError) {
    return { ok: false, error: baseError };
  }

  const type = value.type;
  switch (type) {
    case "replay.begin":
    case "replay.complete":
      {
        const semanticsError = requireReplayControlSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "session.status":
      if (
        value.state !== "idle" &&
        value.state !== "running" &&
        value.state !== "waiting_approval" &&
        value.state !== "restarting" &&
        value.state !== "error" &&
        value.state !== "closed"
      ) {
        return { ok: false, error: "session.status.state is invalid" };
      }
      if (!isOptionalString(value.reason) || !isOptionalString(value.detail)) {
        return { ok: false, error: "session.status reason/detail must be strings when present" };
      }
      if (value.contextStatus !== undefined && !isContextStatus(value.contextStatus)) {
        return { ok: false, error: "session.status.contextStatus is invalid" };
      }
      {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "turn.input":
      if (
        typeof value.turnId !== "string" ||
        typeof value.promptText !== "string" ||
        !isNonEmptyString(value.trigger)
      ) {
        return { ok: false, error: "turn.input payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "custom.message":
      if (
        !isNonEmptyString(value.turnId) ||
        !isNonEmptyString(value.customType) ||
        typeof value.content !== "string" ||
        typeof value.display !== "boolean"
      ) {
        // A turn-less custom cannot be ordered within the transcript; reject it
        // here so the projection fails closed instead of holding it forever.
        return { ok: false, error: "custom.message payload is invalid" };
      }
      {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "turn.transition":
      if (
        typeof value.turnId !== "string" ||
        typeof value.reason !== "string" ||
        !isNonEmptyString(value.status) ||
        !isNonEmptyString(value.family)
      ) {
        return { ok: false, error: "turn.transition payload is invalid" };
      }
      if (
        !(
          value.attempt === undefined ||
          value.attempt === null ||
          (typeof value.attempt === "number" && Number.isFinite(value.attempt))
        )
      ) {
        return { ok: false, error: "turn.transition.attempt is invalid" };
      }
      if (!isOptionalString(value.attemptId) || !isOptionalString(value.error)) {
        return { ok: false, error: "turn.transition optional fields are invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "attempt.started":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        (value.reason !== "initial" &&
          value.reason !== "output_budget_escalation" &&
          value.reason !== "compaction_retry" &&
          value.reason !== "provider_fallback_retry" &&
          value.reason !== "max_output_recovery")
      ) {
        return { ok: false, error: "attempt.started payload is invalid" };
      }
      if (value.reason === "initial") {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      } else {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "attempt.superseded":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        typeof value.supersededByAttemptId !== "string" ||
        (value.reason !== "output_budget_escalation" &&
          value.reason !== "compaction_retry" &&
          value.reason !== "provider_fallback_retry" &&
          value.reason !== "max_output_recovery")
      ) {
        return { ok: false, error: "attempt.superseded payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "assistant.delta":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        (value.lane !== "answer" && value.lane !== "thinking") ||
        typeof value.delta !== "string"
      ) {
        return { ok: false, error: "assistant.delta payload is invalid" };
      }
      {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "tool.started":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        typeof value.toolCallId !== "string" ||
        typeof value.toolName !== "string"
      ) {
        return { ok: false, error: "tool.started payload is invalid" };
      }
      {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "tool.progress":
    case "tool.finished":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        typeof value.toolCallId !== "string" ||
        typeof value.toolName !== "string" ||
        !isNonEmptyString(value.verdict) ||
        typeof value.isError !== "boolean" ||
        typeof value.text !== "string" ||
        !isToolOutputDisplayView(value.display)
      ) {
        return { ok: false, error: `${type} payload is invalid` };
      }
      {
        const semanticsError = requireLiveCacheSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "turn.committed":
      if (
        typeof value.turnId !== "string" ||
        typeof value.attemptId !== "string" ||
        (value.status !== "completed" &&
          value.status !== "failed" &&
          value.status !== "cancelled") ||
        typeof value.assistantText !== "string" ||
        !isAssistantTextSegmentList(value.assistantSegments) ||
        !Array.isArray(value.toolOutputs) ||
        value.toolOutputs.some((entry) => !isToolOutputView(entry))
      ) {
        return { ok: false, error: "turn.committed payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "approval.requested":
      if (
        typeof value.turnId !== "string" ||
        typeof value.requestId !== "string" ||
        typeof value.toolName !== "string" ||
        typeof value.toolCallId !== "string" ||
        typeof value.subject !== "string" ||
        !isOptionalString(value.detail)
      ) {
        return { ok: false, error: "approval.requested payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "approval.decided":
      if (
        typeof value.turnId !== "string" ||
        typeof value.requestId !== "string" ||
        (value.decision !== "accept" && value.decision !== "deny" && value.decision !== "cancel") ||
        !isOptionalString(value.actor) ||
        !isOptionalString(value.reason)
      ) {
        return { ok: false, error: "approval.decided payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "session.closed":
      if (!isOptionalString(value.reason)) {
        return { ok: false, error: "session.closed.reason must be a string when present" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    default:
      return { ok: false, error: `unsupported session wire frame type: ${String(type)}` };
  }
}
