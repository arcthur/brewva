import { isRecord } from "@brewva/brewva-std/unknown";
import {
  SESSION_CRASH_POINTS,
  SESSION_TERMINATION_REASONS,
  type SessionPhase,
} from "@brewva/brewva-substrate/session";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isSessionPhase(value: unknown): value is SessionPhase {
  const phase = asRecord(value);
  switch (phase?.kind) {
    case "idle":
      return true;
    case "model_streaming":
      return isString(phase.modelCallId) && isFiniteNumber(phase.turn);
    case "tool_executing":
      return isString(phase.toolCallId) && isString(phase.toolName) && isFiniteNumber(phase.turn);
    case "waiting_approval":
      return (
        isString(phase.requestId) &&
        isString(phase.toolCallId) &&
        isString(phase.toolName) &&
        isFiniteNumber(phase.turn)
      );
    case "recovering":
      return (
        isFiniteNumber(phase.turn) &&
        (phase.recoveryAnchor === undefined || isString(phase.recoveryAnchor))
      );
    case "crashed":
      return (
        isOneOf(phase.crashAt, SESSION_CRASH_POINTS) &&
        isFiniteNumber(phase.turn) &&
        (phase.modelCallId === undefined || isString(phase.modelCallId)) &&
        (phase.toolCallId === undefined || isString(phase.toolCallId)) &&
        (phase.recoveryAnchor === undefined || isString(phase.recoveryAnchor))
      );
    case "terminated":
      return isOneOf(phase.reason, SESSION_TERMINATION_REASONS);
    default:
      return false;
  }
}
