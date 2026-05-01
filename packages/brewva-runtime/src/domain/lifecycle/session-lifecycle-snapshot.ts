import type { BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { PendingEffectCommitmentRequest } from "../proposals/api.js";
import type {
  SessionLifecycleApprovalSnapshot,
  SessionLifecycleExecutionSnapshot,
  SessionLifecycleSnapshot,
  SessionLifecycleSnapshotBuildInput,
  SessionLifecycleSummarySnapshot,
} from "../sessions/api.js";
import type { OpenToolCallRecord } from "../sessions/api.js";
import type { SessionWireFrame } from "../sessions/api.js";

function resolveApprovalSnapshot(
  pendingApprovals: readonly PendingEffectCommitmentRequest[],
): SessionLifecycleApprovalSnapshot {
  const pending = pendingApprovals[0];
  return {
    status: pending ? "pending" : "idle",
    pendingCount: pendingApprovals.length,
    requestId: pending?.requestId ?? null,
    toolCallId: pending?.toolCallId ?? null,
    toolName: pending?.toolName ?? null,
    subject: pending?.subject ?? null,
  };
}

function resolveLatestOpenToolCall(
  openToolCalls: readonly OpenToolCallRecord[],
): OpenToolCallRecord | undefined {
  return [...openToolCalls].toSorted(
    (left, right) =>
      right.openedAt - left.openedAt || right.toolCallId.localeCompare(left.toolCallId),
  )[0];
}

// Canonical wire-frame reducer for the aggregate execution axis.
// Host/gateway compatibility projectors should prefer the lifecycle snapshot
// and treat their own frame walkers as narrower fallbacks.
function deriveExecutionFromWireFrames(
  sessionId: string,
  frames: readonly SessionWireFrame[],
): SessionLifecycleExecutionSnapshot {
  let current: SessionLifecycleExecutionSnapshot = { kind: "idle" };
  for (const frame of frames) {
    if (!frame || frame.sessionId !== sessionId) {
      continue;
    }
    switch (frame.type) {
      case "turn.input":
      case "attempt.started":
      case "assistant.delta":
        current = { kind: "model_streaming" };
        break;
      case "tool.started":
      case "tool.progress":
        current = {
          kind: "tool_executing",
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
        };
        break;
      case "tool.finished":
      case "approval.decided":
        current = { kind: "model_streaming" };
        break;
      case "approval.requested":
        current = {
          kind: "waiting_approval",
          requestId: frame.requestId,
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          reason: "approval_requested",
          detail: frame.subject,
        };
        break;
      case "turn.transition":
        if (frame.status === "entered") {
          if (frame.family === "approval") {
            const toolContext: {
              toolCallId: BrewvaToolCallId | null;
              toolName: BrewvaToolName | null;
            } | null = ((): {
              toolCallId: BrewvaToolCallId | null;
              toolName: BrewvaToolName | null;
            } | null => {
              switch (current.kind) {
                case "tool_executing":
                case "waiting_approval":
                  return {
                    toolCallId: current.toolCallId,
                    toolName: current.toolName,
                  };
                default:
                  return null;
              }
            })();
            current = {
              kind: "waiting_approval",
              requestId: null,
              toolCallId: toolContext?.toolCallId ?? null,
              toolName: toolContext?.toolName ?? null,
              reason: frame.reason,
              detail: frame.error ?? null,
            };
            break;
          }
          if (frame.family === "recovery" || frame.family === "output_budget") {
            current = {
              kind: "recovering",
              reason: frame.reason,
              detail: frame.error ?? null,
              family: frame.family,
            };
          }
          break;
        }
        if (
          (frame.status === "completed" || frame.status === "skipped") &&
          (frame.family === "approval" ||
            frame.family === "recovery" ||
            frame.family === "output_budget")
        ) {
          current = { kind: "model_streaming" };
        }
        break;
      case "turn.committed":
        current = { kind: "idle" };
        break;
      case "session.closed":
        current = {
          kind: "terminated",
          reason: frame.reason ?? null,
        };
        break;
      default:
        break;
    }
  }
  return current;
}

function resolveExecutionSnapshot(
  input: SessionLifecycleSnapshotBuildInput & {
    approval: SessionLifecycleApprovalSnapshot;
  },
): SessionLifecycleExecutionSnapshot {
  const current = deriveExecutionFromWireFrames(input.sessionId, input.frames);
  if (current.kind === "terminated") {
    return current;
  }

  if (input.approval.status === "pending") {
    return {
      kind: "waiting_approval",
      requestId: input.approval.requestId,
      toolCallId: input.approval.toolCallId,
      toolName: input.approval.toolName,
      reason: "approval_requested",
      detail: input.approval.subject,
    };
  }

  if (input.recovery.pendingFamily !== null || input.recovery.latestStatus === "entered") {
    return {
      kind: "recovering",
      reason: input.recovery.latestReason,
      detail: input.recovery.degradedReason,
      family: input.recovery.pendingFamily,
    };
  }

  const latestOpenToolCall = resolveLatestOpenToolCall(input.openToolCalls);
  if (latestOpenToolCall) {
    return {
      kind: "tool_executing",
      toolCallId: latestOpenToolCall.toolCallId,
      toolName: latestOpenToolCall.toolName,
    };
  }

  return current;
}

function resolveSkillPosture(
  input: SessionLifecycleSnapshotBuildInput,
): SessionLifecycleSnapshot["skill"] {
  const activeSkillState = input.activeSkillState
    ? structuredClone(input.activeSkillState)
    : undefined;
  const latestFailure = input.latestSkillFailure
    ? structuredClone(input.latestSkillFailure)
    : undefined;
  if (activeSkillState?.phase === "repair_required") {
    return {
      posture: "repair_required",
      activeSkillName: activeSkillState.skillName,
      activeSkillState,
      ...(latestFailure ? { latestFailure } : {}),
    };
  }
  if (activeSkillState) {
    return {
      posture: "active",
      activeSkillName: activeSkillState.skillName,
      activeSkillState,
      ...(latestFailure ? { latestFailure } : {}),
    };
  }
  return {
    posture: "none",
    activeSkillName: latestFailure?.skillName ?? null,
    ...(latestFailure ? { latestFailure } : {}),
  };
}

function resolveSummarySnapshot(
  input: SessionLifecycleSnapshotBuildInput & {
    execution: SessionLifecycleExecutionSnapshot;
    skill: SessionLifecycleSnapshot["skill"];
  },
): SessionLifecycleSummarySnapshot {
  if (input.hydration.status === "cold") {
    return {
      kind: "cold",
      reason: null,
      detail: null,
    };
  }

  if (input.execution.kind === "terminated") {
    return {
      kind: "closed",
      reason: input.execution.reason,
      detail: null,
    };
  }

  if (input.integrity.status !== "healthy" || input.recovery.mode === "degraded") {
    return {
      kind: "degraded",
      reason: input.recovery.degradedReason ?? input.integrity.issues[0]?.reason ?? null,
      detail: null,
    };
  }

  if (input.recovery.mode === "diagnostic_only") {
    return {
      kind: "degraded",
      reason: input.recovery.degradedReason ?? "recovery_diagnostic_only",
      detail: null,
    };
  }

  if (input.execution.kind === "recovering") {
    return {
      kind: "recovering",
      reason: input.execution.reason,
      detail: input.execution.detail,
    };
  }

  if (input.execution.kind === "waiting_approval") {
    return {
      kind: "blocked",
      reason: input.execution.reason,
      detail: input.execution.detail,
    };
  }

  if (input.skill.posture === "repair_required") {
    return {
      kind: "blocked",
      reason: "skill_repair_required",
      detail: input.skill.activeSkillName,
    };
  }

  if (input.execution.kind === "model_streaming" || input.execution.kind === "tool_executing") {
    return {
      kind: "active",
      reason: null,
      detail: null,
    };
  }

  return {
    kind: "idle",
    reason: null,
    detail: null,
  };
}

export function buildSessionLifecycleSnapshot(
  input: SessionLifecycleSnapshotBuildInput,
): SessionLifecycleSnapshot {
  const approval = resolveApprovalSnapshot(input.pendingApprovals);
  const execution = resolveExecutionSnapshot({
    ...input,
    approval,
  });
  const skill = resolveSkillPosture(input);
  return {
    hydration: structuredClone(input.hydration),
    execution,
    recovery: structuredClone(input.recovery),
    skill,
    approval,
    tooling: {
      openToolCalls: input.openToolCalls.map((record) => ({ ...record })),
    },
    integrity: structuredClone(input.integrity),
    summary: resolveSummarySnapshot({
      ...input,
      execution,
      skill,
    }),
  };
}
