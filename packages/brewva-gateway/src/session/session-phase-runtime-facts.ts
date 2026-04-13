import type { SessionWireFrame } from "@brewva/brewva-runtime";
import type { SessionPhase } from "@brewva/brewva-substrate";

export interface RuntimeFactSessionPhaseProjection {
  phase: SessionPhase;
  reason?: string;
  detail?: string;
}

function resolveApprovalToolContext(
  current: SessionPhase,
): { toolCallId: string; toolName: string } | null {
  if (current.kind === "tool_executing" || current.kind === "waiting_approval") {
    return {
      toolCallId: current.toolCallId,
      toolName: current.toolName,
    };
  }
  return null;
}

function resolveTurnNumber(current: SessionPhase, fallbackTurn: number): number {
  if ("turn" in current && typeof current.turn === "number" && Number.isFinite(current.turn)) {
    return current.turn;
  }
  return fallbackTurn > 0 ? fallbackTurn : 1;
}

export function deriveSessionPhaseFromRuntimeFactFrame(
  current: SessionPhase,
  frame: SessionWireFrame,
  fallbackTurn: number,
): RuntimeFactSessionPhaseProjection | null {
  switch (frame.type) {
    case "approval.requested":
      return {
        phase: {
          kind: "waiting_approval",
          requestId: frame.requestId,
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          turn: resolveTurnNumber(current, fallbackTurn),
        },
        reason: "approval_requested",
        detail: frame.subject,
      };
    case "approval.decided":
      if (current.kind !== "waiting_approval") {
        return null;
      }
      return {
        phase: { kind: "idle" },
        reason: frame.reason,
      };
    case "turn.transition":
      if (frame.status === "entered") {
        if (frame.family === "approval") {
          const toolContext = resolveApprovalToolContext(current);
          if (!toolContext) {
            return null;
          }
          return {
            phase: {
              kind: "waiting_approval",
              requestId: `transition:${frame.reason}`,
              toolCallId: toolContext.toolCallId,
              toolName: toolContext.toolName,
              turn: resolveTurnNumber(current, fallbackTurn),
            },
            reason: frame.reason,
            detail: frame.error,
          };
        }
        if (frame.family === "recovery" || frame.family === "output_budget") {
          return {
            phase: {
              kind: "recovering",
              recoveryAnchor: `transition:${frame.reason}`,
              turn: resolveTurnNumber(current, fallbackTurn),
            },
            reason: frame.reason,
            detail: frame.error,
          };
        }
        return null;
      }
      if (
        (frame.status === "completed" || frame.status === "skipped") &&
        frame.family === "approval" &&
        current.kind === "waiting_approval"
      ) {
        return {
          phase: { kind: "idle" },
          reason: frame.reason,
          detail: frame.error,
        };
      }
      if (
        (frame.status === "completed" || frame.status === "skipped") &&
        (frame.family === "recovery" || frame.family === "output_budget") &&
        current.kind === "recovering"
      ) {
        return {
          phase: { kind: "idle" },
          reason: frame.reason,
          detail: frame.error,
        };
      }
      return null;
    case "session.closed":
      return {
        phase: {
          kind: "terminated",
          reason: "host_closed",
        },
        reason: frame.reason,
      };
    default:
      return null;
  }
}

export function deriveSessionPhaseFromRuntimeFactHistory(
  sessionId: string,
  frames: readonly SessionWireFrame[],
): RuntimeFactSessionPhaseProjection {
  let current: RuntimeFactSessionPhaseProjection = {
    phase: { kind: "idle" },
  };
  let turnNumber = 0;

  for (const frame of frames) {
    if (!frame || frame.sessionId !== sessionId) {
      continue;
    }
    if (frame.type === "turn.input") {
      turnNumber += 1;
    }

    const next = deriveSessionPhaseFromRuntimeFactFrame(current.phase, frame, turnNumber);
    if (next) {
      current = next;
      continue;
    }

    if (
      frame.type === "turn.committed" &&
      current.phase.kind !== "terminated" &&
      current.phase.kind !== "idle"
    ) {
      current = {
        phase: { kind: "idle" },
      };
    }
  }

  return current;
}
