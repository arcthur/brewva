import type { SessionWireFrame, SessionWireStatusState } from "@brewva/brewva-runtime";

export interface SessionStatusSeed {
  state: SessionWireStatusState;
  reason?: string;
  detail?: string;
}

export function sameSessionStatusSeed(
  left: SessionStatusSeed | undefined,
  right: SessionStatusSeed | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.state === right.state && left.reason === right.reason && left.detail === right.detail;
}

export function deriveSessionStatusSeedFromHistory(
  sessionId: string,
  frames: readonly SessionWireFrame[],
  fallbackState: SessionWireStatusState,
): SessionStatusSeed {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (!frame || frame.sessionId !== sessionId) {
      continue;
    }
    switch (frame.type) {
      case "session.closed":
        return {
          state: "closed",
          reason: frame.reason,
        };
      case "approval.requested":
        return {
          state: "waiting_approval",
          reason: "approval_requested",
          detail: frame.subject,
        };
      case "turn.transition":
        if (frame.status !== "entered") {
          continue;
        }
        if (frame.family === "approval") {
          return {
            state: "waiting_approval",
            reason: frame.reason,
            detail: frame.error,
          };
        }
        if (frame.family === "recovery" || frame.family === "output_budget") {
          return {
            state: "restarting",
            reason: frame.reason,
            detail: frame.error,
          };
        }
        continue;
      case "turn.committed":
        return {
          state: frame.status === "failed" ? "error" : fallbackState,
          reason: frame.status === "failed" ? "turn_failed" : undefined,
        };
      case "turn.input":
        return {
          state: fallbackState === "idle" ? "running" : fallbackState,
        };
      default:
        continue;
    }
  }

  return {
    state: fallbackState,
  };
}

export function deriveSessionStatusSeedFromFrame(
  frame: SessionWireFrame,
): SessionStatusSeed | null {
  switch (frame.type) {
    case "turn.input":
    case "attempt.started":
    case "assistant.delta":
    case "tool.started":
    case "tool.progress":
    case "tool.finished":
    case "approval.decided":
      return {
        state: "running",
      };
    case "approval.requested":
      return {
        state: "waiting_approval",
        reason: "approval_requested",
        detail: frame.subject,
      };
    case "turn.transition":
      if (frame.status === "entered") {
        if (frame.family === "approval") {
          return {
            state: "waiting_approval",
            reason: frame.reason,
            detail: frame.error,
          };
        }
        if (frame.family === "recovery" || frame.family === "output_budget") {
          return {
            state: "restarting",
            reason: frame.reason,
            detail: frame.error,
          };
        }
      }
      if (
        (frame.status === "completed" || frame.status === "skipped") &&
        (frame.family === "approval" ||
          frame.family === "recovery" ||
          frame.family === "output_budget")
      ) {
        return {
          state: "running",
        };
      }
      return null;
    case "turn.committed":
      return {
        state: frame.status === "failed" ? "error" : "idle",
        reason: frame.status === "failed" ? "turn_failed" : undefined,
      };
    case "session.closed":
      return {
        state: "closed",
        reason: frame.reason,
      };
    default:
      return null;
  }
}
