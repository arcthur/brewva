import type {
  SessionLifecycleSnapshot,
  SessionWireFrame,
  SessionWireStatusState,
} from "@brewva/brewva-runtime";

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

function deriveSessionStatusSeedFromFrameWithFallback(
  frame: SessionWireFrame,
  fallbackState: SessionWireStatusState,
): SessionStatusSeed | null {
  switch (frame.type) {
    case "turn.input":
      return {
        state: fallbackState === "idle" ? "running" : fallbackState,
      };
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

export function deriveSessionStatusSeedFromHistory(
  sessionId: string,
  frames: readonly SessionWireFrame[],
  fallbackState: SessionWireStatusState,
): SessionStatusSeed {
  let current: SessionStatusSeed = {
    state: fallbackState,
  };

  for (const frame of frames) {
    if (!frame || frame.sessionId !== sessionId) {
      continue;
    }
    const next = deriveSessionStatusSeedFromFrameWithFallback(frame, fallbackState);
    if (next) {
      current = next;
    }
  }

  return current;
}

export function deriveSessionStatusSeedFromLifecycleSnapshot(
  snapshot: SessionLifecycleSnapshot,
): SessionStatusSeed | null {
  if (snapshot.summary.kind === "blocked" && snapshot.execution.kind === "waiting_approval") {
    return {
      state: "waiting_approval",
      reason: snapshot.summary.reason ?? undefined,
      detail: snapshot.summary.detail ?? undefined,
    };
  }

  if (
    (snapshot.summary.kind === "recovering" || snapshot.summary.kind === "degraded") &&
    snapshot.execution.kind === "recovering"
  ) {
    return {
      state: "restarting",
      reason: snapshot.summary.reason ?? undefined,
      detail: snapshot.summary.detail ?? undefined,
    };
  }

  if (snapshot.summary.kind === "closed") {
    return {
      state: "closed",
      reason: snapshot.summary.reason ?? undefined,
    };
  }

  return null;
}

export function deriveSessionStatusSeedFromFrame(
  frame: SessionWireFrame,
): SessionStatusSeed | null {
  return deriveSessionStatusSeedFromFrameWithFallback(frame, "running");
}
