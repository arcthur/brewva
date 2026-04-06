import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-runtime";
import { Ajv, type ErrorObject } from "ajv";
import {
  ConnectParamsSchema,
  type GatewayMethod,
  GatewayStopParamsSchema,
  GatewayRotateTokenParamsSchema,
  GatewayFrameSchema,
  HeartbeatReloadParamsSchema,
  HealthParamsSchema,
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  SchedulerPauseParamsSchema,
  SchedulerResumeParamsSchema,
  SessionsAbortParamsSchema,
  SessionsCloseParamsSchema,
  SessionsOpenParamsSchema,
  SessionsSubscribeParamsSchema,
  SessionsSendParamsSchema,
  SessionsUnsubscribeParamsSchema,
  StatusDeepParamsSchema,
  type GatewayParamsByMethod,
} from "./schema.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateRequestFrame = ajv.compile(RequestFrameSchema);
export const validateResponseFrame = ajv.compile(ResponseFrameSchema);
export const validateEventFrame = ajv.compile(EventFrameSchema);
export const validateGatewayFrame = ajv.compile(GatewayFrameSchema);

export const validateConnectParams = ajv.compile(ConnectParamsSchema);
export const validateHealthParams = ajv.compile(HealthParamsSchema);
export const validateStatusDeepParams = ajv.compile(StatusDeepParamsSchema);
export const validateSchedulerPauseParams = ajv.compile(SchedulerPauseParamsSchema);
export const validateSchedulerResumeParams = ajv.compile(SchedulerResumeParamsSchema);
export const validateSessionsOpenParams = ajv.compile(SessionsOpenParamsSchema);
export const validateSessionsSubscribeParams = ajv.compile(SessionsSubscribeParamsSchema);
export const validateSessionsUnsubscribeParams = ajv.compile(SessionsUnsubscribeParamsSchema);
export const validateSessionsSendParams = ajv.compile(SessionsSendParamsSchema);
export const validateSessionsAbortParams = ajv.compile(SessionsAbortParamsSchema);
export const validateSessionsCloseParams = ajv.compile(SessionsCloseParamsSchema);
export const validateHeartbeatReloadParams = ajv.compile(HeartbeatReloadParamsSchema);
export const validateGatewayStopParams = ajv.compile(GatewayStopParamsSchema);
export const validateGatewayRotateTokenParams = ajv.compile(GatewayRotateTokenParamsSchema);

const methodValidators: {
  [K in GatewayMethod]: {
    validate: (value: unknown) => boolean;
    errors: () => ErrorObject[] | null | undefined;
  };
} = {
  connect: {
    validate: validateConnectParams,
    errors: () => validateConnectParams.errors,
  },
  health: {
    validate: validateHealthParams,
    errors: () => validateHealthParams.errors,
  },
  "status.deep": {
    validate: validateStatusDeepParams,
    errors: () => validateStatusDeepParams.errors,
  },
  "scheduler.pause": {
    validate: validateSchedulerPauseParams,
    errors: () => validateSchedulerPauseParams.errors,
  },
  "scheduler.resume": {
    validate: validateSchedulerResumeParams,
    errors: () => validateSchedulerResumeParams.errors,
  },
  "sessions.open": {
    validate: validateSessionsOpenParams,
    errors: () => validateSessionsOpenParams.errors,
  },
  "sessions.subscribe": {
    validate: validateSessionsSubscribeParams,
    errors: () => validateSessionsSubscribeParams.errors,
  },
  "sessions.unsubscribe": {
    validate: validateSessionsUnsubscribeParams,
    errors: () => validateSessionsUnsubscribeParams.errors,
  },
  "sessions.send": {
    validate: validateSessionsSendParams,
    errors: () => validateSessionsSendParams.errors,
  },
  "sessions.abort": {
    validate: validateSessionsAbortParams,
    errors: () => validateSessionsAbortParams.errors,
  },
  "sessions.close": {
    validate: validateSessionsCloseParams,
    errors: () => validateSessionsCloseParams.errors,
  },
  "heartbeat.reload": {
    validate: validateHeartbeatReloadParams,
    errors: () => validateHeartbeatReloadParams.errors,
  },
  "gateway.rotate-token": {
    validate: validateGatewayRotateTokenParams,
    errors: () => validateGatewayRotateTokenParams.errors,
  },
  "gateway.stop": {
    validate: validateGatewayStopParams,
    errors: () => validateGatewayStopParams.errors,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isSource(value: unknown): value is SessionWireFrame["source"] {
  return value === "live" || value === "replay";
}

function isDurability(value: unknown): value is SessionWireFrame["durability"] {
  return value === "cache" || value === "durable";
}

function isContextPressure(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNumber(value.tokens) &&
    isFiniteNumber(value.limit) &&
    (value.level === "normal" || value.level === "elevated" || value.level === "critical")
  );
}

function isToolVerdict(value: unknown): boolean {
  return value === "pass" || value === "fail" || value === "inconclusive";
}

function isToolOutputView(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    isToolVerdict(value.verdict) &&
    typeof value.isError === "boolean" &&
    typeof value.text === "string"
  );
}

function hasSessionWireBase(value: Record<string, unknown>): string | null {
  if (value.schema !== SESSION_WIRE_SCHEMA) {
    return `schema must be ${SESSION_WIRE_SCHEMA}`;
  }
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) {
    return "sessionId must be a non-empty string";
  }
  if (typeof value.frameId !== "string" || !value.frameId.trim()) {
    return "frameId must be a non-empty string";
  }
  if (!isFiniteNumber(value.ts)) {
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
  if (typeof value.type !== "string" || !value.type.trim()) {
    return "type must be a non-empty string";
  }
  return null;
}

function hasSourceProvenance(value: Record<string, unknown>): boolean {
  return (
    typeof value.sourceEventId === "string" &&
    value.sourceEventId.trim().length > 0 &&
    typeof value.sourceEventType === "string" &&
    value.sourceEventType.trim().length > 0
  );
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
      if (value.contextPressure !== undefined && !isContextPressure(value.contextPressure)) {
        return { ok: false, error: "session.status.contextPressure is invalid" };
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
        (value.trigger !== "user" &&
          value.trigger !== "schedule" &&
          value.trigger !== "heartbeat" &&
          value.trigger !== "channel" &&
          value.trigger !== "recovery")
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
    case "turn.transition":
      if (
        typeof value.turnId !== "string" ||
        typeof value.reason !== "string" ||
        (value.status !== "entered" &&
          value.status !== "completed" &&
          value.status !== "failed" &&
          value.status !== "skipped") ||
        (value.family !== "context" &&
          value.family !== "output_budget" &&
          value.family !== "approval" &&
          value.family !== "delegation" &&
          value.family !== "interrupt" &&
          value.family !== "recovery")
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
          value.reason !== "max_output_recovery" &&
          value.reason !== "reasoning_revert_resume")
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
          value.reason !== "max_output_recovery" &&
          value.reason !== "reasoning_revert_resume")
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
        !isToolVerdict(value.verdict) ||
        typeof value.isError !== "boolean" ||
        typeof value.text !== "string"
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
        (value.decision !== "approved" && value.decision !== "rejected") ||
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
    case "subagent.started":
      if (
        typeof value.turnId !== "string" ||
        typeof value.runId !== "string" ||
        typeof value.delegate !== "string" ||
        typeof value.kind !== "string" ||
        (value.lifecycle !== "spawned" && value.lifecycle !== "running") ||
        !isOptionalString(value.label)
      ) {
        return { ok: false, error: "subagent.started payload is invalid" };
      }
      {
        const semanticsError = requireDurableSemantics(value, type);
        if (semanticsError) {
          return { ok: false, error: semanticsError };
        }
      }
      return { ok: true, frame: asSessionWireFrame(value) };
    case "subagent.finished":
      if (
        typeof value.turnId !== "string" ||
        typeof value.runId !== "string" ||
        typeof value.delegate !== "string" ||
        typeof value.kind !== "string" ||
        (value.status !== "completed" &&
          value.status !== "failed" &&
          value.status !== "cancelled") ||
        !isOptionalString(value.summary)
      ) {
        return { ok: false, error: "subagent.finished payload is invalid" };
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

export function validateParamsForMethod<K extends GatewayMethod>(
  method: K,
  params: unknown,
): { ok: true; params: GatewayParamsByMethod[K] } | { ok: false; error: string } {
  const validator = methodValidators[method];
  if (validator.validate(params)) {
    return {
      ok: true,
      params: params as GatewayParamsByMethod[K],
    };
  }
  return {
    ok: false,
    error: formatValidationErrors(validator.errors()),
  };
}

export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return "unknown validation error";
  }

  const messages: string[] = [];
  for (const error of errors) {
    const path =
      typeof error.instancePath === "string" && error.instancePath
        ? `at ${error.instancePath}`
        : "at root";
    const message = typeof error.message === "string" ? error.message : "validation error";
    if (error.keyword === "additionalProperties") {
      const params = error.params as { additionalProperty?: unknown } | undefined;
      const prop =
        typeof params?.additionalProperty === "string" ? params.additionalProperty : null;
      if (prop) {
        messages.push(`${path}: unexpected property '${prop}'`);
        continue;
      }
    }
    messages.push(`${path}: ${message}`);
  }
  return Array.from(new Set(messages)).join("; ");
}
