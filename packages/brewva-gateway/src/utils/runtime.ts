import { type BrewvaHostedRuntimePort, type BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  appendBrewvaEventRecordToLogIfMissing,
  recordRuntimeEvent,
} from "@brewva/brewva-runtime/internal";

export function clampText(value: string, maxChars: number): string;
export function clampText(value: string | undefined, maxChars: number): string | undefined;
export function clampText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function renderUnknownError(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

export function ensureSessionShutdownRecorded(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  sessionId: string,
  payload?: Record<string, unknown>,
): void {
  if (runtime.inspect.events.query(sessionId, { type: "session_shutdown", last: 1 }).length > 0)
    return;
  recordRuntimeEvent(runtime, {
    sessionId,
    type: "session_shutdown",
    payload,
  });
}

function buildSessionShutdownPayload(input: {
  reason: string;
  source: string;
  error?: unknown;
  exitCode?: number | null;
  signal?: string | null;
  workerSessionId?: string;
  recoveredFromRegistry?: boolean;
}): Record<string, unknown> {
  const errorText = clampText(renderUnknownError(input.error), 320) ?? undefined;
  return {
    reason: input.reason,
    source: input.source,
    error: errorText,
    exitCode: input.exitCode ?? null,
    signal: input.signal ?? null,
    workerSessionId: input.workerSessionId ?? null,
    recoveredFromRegistry: input.recoveredFromRegistry === true,
  };
}

export function recordSessionShutdownIfMissing(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    reason: string;
    source: string;
    error?: unknown;
    exitCode?: number | null;
    signal?: string | null;
    workerSessionId?: string;
    recoveredFromRegistry?: boolean;
  },
): void {
  ensureSessionShutdownRecorded(runtime, input.sessionId, buildSessionShutdownPayload(input));
}

export function recordAbnormalSessionShutdown(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    source: string;
    error?: unknown;
  },
): void {
  recordSessionShutdownIfMissing(runtime, {
    sessionId: input.sessionId,
    reason: "abnormal_process_exit",
    source: input.source,
    error: input.error,
  });
}

export function recordSessionShutdownReceiptToEventLogIfMissing(input: {
  eventLogPath: string;
  sessionId: string;
  reason: string;
  source: string;
  error?: unknown;
  exitCode?: number | null;
  signal?: string | null;
  workerSessionId?: string;
  recoveredFromRegistry?: boolean;
}): boolean {
  return Boolean(
    appendBrewvaEventRecordToLogIfMissing(input.eventLogPath, {
      sessionId: input.sessionId,
      type: "session_shutdown",
      payload: buildSessionShutdownPayload(input),
    }),
  );
}
