import { type SessionLifecycleSnapshot } from "@brewva/brewva-runtime";
import type { SessionPhase, SessionPhaseEvent } from "@brewva/brewva-substrate/session";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import type { RuntimeFactSessionPhaseProjection } from "./runtime-facts.js";

export function inferRecoveryCrashPoint(
  current: SessionPhase,
): "model_streaming" | "tool_executing" | "wal_append" {
  switch (current.kind) {
    case "model_streaming":
      return "model_streaming";
    case "tool_executing":
    case "waiting_approval":
      return "tool_executing";
    default:
      return "wal_append";
  }
}

export function deriveSessionPhaseFromLifecycleSnapshot(
  snapshot: SessionLifecycleSnapshot,
  fallbackTurn: number,
): RuntimeFactSessionPhaseProjection | null {
  const resolvedTurn = fallbackTurn > 0 ? fallbackTurn : 1;
  switch (snapshot.execution.kind) {
    case "idle":
      return {
        phase: { kind: "idle" },
      };
    case "tool_executing": {
      const toolCallId = snapshot.execution.toolCallId;
      const toolName = snapshot.execution.toolName;
      const toolExecutionTurn =
        snapshot.tooling.openToolCalls.find((record) => record.toolCallId === toolCallId)?.turn ??
        resolvedTurn;
      return {
        phase: {
          kind: "tool_executing",
          toolCallId,
          toolName,
          turn: toolExecutionTurn,
        },
      };
    }
    case "waiting_approval": {
      if (!snapshot.execution.toolCallId || !snapshot.execution.toolName) {
        return null;
      }
      return {
        phase: {
          kind: "waiting_approval",
          requestId:
            snapshot.execution.requestId ?? `transition:${snapshot.execution.reason ?? "approval"}`,
          toolCallId: snapshot.execution.toolCallId,
          toolName: snapshot.execution.toolName,
          turn: resolvedTurn,
        },
        reason: snapshot.execution.reason ?? undefined,
        detail: snapshot.execution.detail ?? undefined,
      };
    }
    case "recovering":
      return {
        phase: {
          kind: "recovering",
          recoveryAnchor: snapshot.execution.reason
            ? `transition:${snapshot.execution.reason}`
            : undefined,
          turn: resolvedTurn,
        },
        reason: snapshot.execution.reason ?? undefined,
        detail: snapshot.execution.detail ?? undefined,
      };
    case "terminated":
      return {
        phase: {
          kind: "terminated",
          reason: "host_closed",
        },
        reason: snapshot.execution.reason ?? undefined,
      };
    default:
      return null;
  }
}

export function sameSessionPhase(left: SessionPhase, right: SessionPhase): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "idle":
      return true;
    case "model_streaming": {
      const next = right as Extract<SessionPhase, { kind: "model_streaming" }>;
      return left.modelCallId === next.modelCallId && left.turn === next.turn;
    }
    case "tool_executing": {
      const next = right as Extract<SessionPhase, { kind: "tool_executing" }>;
      return (
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "waiting_approval": {
      const next = right as Extract<SessionPhase, { kind: "waiting_approval" }>;
      return (
        left.requestId === next.requestId &&
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "recovering": {
      const next = right as Extract<SessionPhase, { kind: "recovering" }>;
      return left.recoveryAnchor === next.recoveryAnchor && left.turn === next.turn;
    }
    case "crashed": {
      const next = right as Extract<SessionPhase, { kind: "crashed" }>;
      return (
        left.crashAt === next.crashAt &&
        left.turn === next.turn &&
        left.modelCallId === next.modelCallId &&
        left.toolCallId === next.toolCallId &&
        left.recoveryAnchor === next.recoveryAnchor
      );
    }
    case "terminated": {
      const next = right as Extract<SessionPhase, { kind: "terminated" }>;
      return left.reason === next.reason;
    }
  }

  const exhaustive: never = left;
  return exhaustive;
}

export function deriveCompatibilityValidationEvent(
  previousPhase: SessionPhase,
  nextPhase: SessionPhase,
): SessionPhaseEvent | null {
  switch (nextPhase.kind) {
    case "idle":
      switch (previousPhase.kind) {
        case "model_streaming":
          return { type: "finish_model_stream" };
        case "tool_executing":
          return { type: "finish_tool_execution" };
        case "waiting_approval":
          return { type: "approval_resolved" };
        case "recovering":
          return { type: "finish_recovery" };
        default:
          return null;
      }
    case "model_streaming":
      return {
        type: "start_model_stream",
        modelCallId: nextPhase.modelCallId,
        turn: nextPhase.turn,
      };
    case "tool_executing":
      return {
        type: "start_tool_execution",
        toolCallId: nextPhase.toolCallId,
        toolName: nextPhase.toolName,
        turn: nextPhase.turn,
      };
    case "waiting_approval":
      return previousPhase.kind === "tool_executing"
        ? {
            type: "wait_for_approval",
            requestId: nextPhase.requestId,
          }
        : null;
    case "recovering":
      return previousPhase.kind === "crashed"
        ? {
            type: "resume",
          }
        : null;
    case "crashed":
      return {
        type: "crash",
        crashAt: nextPhase.crashAt,
        turn: nextPhase.turn,
        recoveryAnchor: nextPhase.recoveryAnchor,
        modelCallId: nextPhase.modelCallId,
        toolCallId: nextPhase.toolCallId,
      };
    case "terminated":
      return {
        type: "terminate",
        reason: nextPhase.reason,
      };
  }

  const exhaustive: never = nextPhase;
  return exhaustive;
}

export function resolveModelCallId(
  message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>,
  turn: number,
): string {
  return typeof message.responseId === "string" && message.responseId.trim().length > 0
    ? message.responseId
    : `turn:${turn}:assistant`;
}

export function resolvePhaseTurn(turnIndex: number): number {
  return turnIndex > 0 ? turnIndex : 1;
}
