import type {
  SessionCrashPoint,
  SessionPhase,
  SessionPhaseTransitionResult,
  SessionTerminationReason,
} from "../contracts/session-phase.js";

export type SessionPhaseEvent =
  | { type: "start_model_stream"; modelCallId: string; turn: number }
  | { type: "finish_model_stream" }
  | { type: "start_tool_execution"; toolCallId: string; toolName: string; turn: number }
  | { type: "finish_tool_execution" }
  | { type: "wait_for_approval"; requestId: string }
  | { type: "approval_resolved" }
  | {
      type: "crash";
      crashAt: SessionCrashPoint;
      turn?: number;
      recoveryAnchor?: string;
      modelCallId?: string;
      toolCallId?: string;
    }
  | { type: "resume" }
  | { type: "finish_recovery" }
  | { type: "terminate"; reason: SessionTerminationReason };

function invalidSessionPhaseTransition(): SessionPhaseTransitionResult {
  return { ok: false, error: "invalid session phase transition" };
}

function buildCrashPhase(
  current: SessionPhase,
  event: Extract<SessionPhaseEvent, { type: "crash" }>,
): SessionPhaseTransitionResult {
  if (current.kind === "terminated") {
    return invalidSessionPhaseTransition();
  }

  const modelCallId = current.kind === "model_streaming" ? current.modelCallId : event.modelCallId;
  const toolCallId =
    current.kind === "tool_executing" || current.kind === "waiting_approval"
      ? current.toolCallId
      : event.toolCallId;

  return {
    ok: true,
    phase: {
      kind: "crashed",
      crashAt: event.crashAt,
      turn: "turn" in current ? current.turn : (event.turn ?? 0),
      ...(modelCallId ? { modelCallId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      recoveryAnchor:
        event.recoveryAnchor ??
        (current.kind === "recovering" || current.kind === "crashed"
          ? current.recoveryAnchor
          : undefined),
    },
  };
}

export function canTransitionSessionPhase(
  current: SessionPhase,
  event: SessionPhaseEvent,
): boolean {
  return advanceSessionPhaseResult(current, event).ok;
}

export function advanceSessionPhaseResult(
  current: SessionPhase,
  event: SessionPhaseEvent,
): SessionPhaseTransitionResult {
  switch (event.type) {
    case "start_model_stream":
      if (current.kind !== "idle") {
        return invalidSessionPhaseTransition();
      }
      return {
        ok: true,
        phase: {
          kind: "model_streaming",
          modelCallId: event.modelCallId,
          turn: event.turn,
        },
      };
    case "finish_model_stream":
      if (current.kind !== "model_streaming") {
        return invalidSessionPhaseTransition();
      }
      return { ok: true, phase: { kind: "idle" } };
    case "start_tool_execution":
      if (current.kind !== "idle") {
        return invalidSessionPhaseTransition();
      }
      return {
        ok: true,
        phase: {
          kind: "tool_executing",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          turn: event.turn,
        },
      };
    case "finish_tool_execution":
      if (current.kind !== "tool_executing") {
        return invalidSessionPhaseTransition();
      }
      return { ok: true, phase: { kind: "idle" } };
    case "wait_for_approval":
      if (current.kind !== "tool_executing") {
        return invalidSessionPhaseTransition();
      }
      return {
        ok: true,
        phase: {
          kind: "waiting_approval",
          requestId: event.requestId,
          toolCallId: current.toolCallId,
          toolName: current.toolName,
          turn: current.turn,
        },
      };
    case "approval_resolved":
      if (current.kind !== "waiting_approval") {
        return invalidSessionPhaseTransition();
      }
      return { ok: true, phase: { kind: "idle" } };
    case "crash":
      return buildCrashPhase(current, event);
    case "resume":
      if (current.kind !== "crashed") {
        return invalidSessionPhaseTransition();
      }
      return {
        ok: true,
        phase: {
          kind: "recovering",
          recoveryAnchor: current.recoveryAnchor,
          turn: current.turn,
        },
      };
    case "finish_recovery":
      if (current.kind !== "recovering") {
        return invalidSessionPhaseTransition();
      }
      return { ok: true, phase: { kind: "idle" } };
    case "terminate":
      if (current.kind === "terminated") {
        return invalidSessionPhaseTransition();
      }
      return {
        ok: true,
        phase: {
          kind: "terminated",
          reason: event.reason,
        },
      };
  }

  const exhaustive: never = event;
  return exhaustive;
}
