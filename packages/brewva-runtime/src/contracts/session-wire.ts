import type { DelegationOutcomeKind } from "./delegation.js";

export const SESSION_WIRE_SCHEMA = "brewva.session-wire.v2" as const;

export type SessionWireSource = "replay" | "live";
export type SessionWireDurability = "durable" | "cache";
export type SessionWireTurnTrigger = "user" | "schedule" | "heartbeat" | "channel" | "recovery";
export type SessionWireAttemptReason =
  | "initial"
  | "output_budget_escalation"
  | "compaction_retry"
  | "provider_fallback_retry"
  | "max_output_recovery";
export type SessionWireTransitionFamily =
  | "context"
  | "output_budget"
  | "approval"
  | "delegation"
  | "interrupt"
  | "recovery";
export type SessionWireTransitionStatus = "entered" | "completed" | "failed" | "skipped";
export type SessionWireCommittedStatus = "completed" | "failed" | "cancelled";
export type SessionWireStatusState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "restarting"
  | "error"
  | "closed";

export interface ContextPressureView {
  tokens: number;
  limit: number;
  level: "normal" | "elevated" | "critical";
}

export interface ToolOutputView {
  toolCallId: string;
  toolName: string;
  verdict: "pass" | "fail" | "inconclusive";
  isError: boolean;
  text: string;
}

export interface TurnInputRecordedPayload {
  turnId: string;
  trigger: SessionWireTurnTrigger;
  promptText: string;
}

export interface TurnRenderCommittedPayload {
  turnId: string;
  attemptId: string;
  status: SessionWireCommittedStatus;
  assistantText: string;
  toolOutputs: ToolOutputView[];
}

export interface SessionWireFrameBase {
  schema: typeof SESSION_WIRE_SCHEMA;
  sessionId: string;
  frameId: string;
  ts: number;
  source: SessionWireSource;
  durability: SessionWireDurability;
  sourceEventId?: string;
  sourceEventType?: string;
}

export type SessionWireFrame =
  | (SessionWireFrameBase & {
      type: "replay.begin";
    })
  | (SessionWireFrameBase & {
      type: "replay.complete";
    })
  | (SessionWireFrameBase & {
      type: "session.status";
      state: SessionWireStatusState;
      reason?: string;
      detail?: string;
      contextPressure?: ContextPressureView;
    })
  | (SessionWireFrameBase & {
      type: "turn.input";
      turnId: string;
      trigger: SessionWireTurnTrigger;
      promptText: string;
    })
  | (SessionWireFrameBase & {
      type: "turn.transition";
      turnId: string;
      reason: string;
      status: SessionWireTransitionStatus;
      family: SessionWireTransitionFamily;
      attempt?: number | null;
      attemptId?: string;
      error?: string;
    })
  | (SessionWireFrameBase & {
      type: "attempt.started";
      turnId: string;
      attemptId: string;
      reason: SessionWireAttemptReason;
    })
  | (SessionWireFrameBase & {
      type: "attempt.superseded";
      turnId: string;
      attemptId: string;
      supersededByAttemptId: string;
      reason: Exclude<SessionWireAttemptReason, "initial">;
    })
  | (SessionWireFrameBase & {
      type: "assistant.delta";
      turnId: string;
      attemptId: string;
      lane: "answer" | "thinking";
      delta: string;
    })
  // Live tool preview frames are explicitly attempt-scoped in v2.
  // Replay still converges through the committed `turn.committed.toolOutputs`
  // view rather than through standalone durable tool frames.
  | (SessionWireFrameBase & {
      type: "tool.started";
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
    })
  | (SessionWireFrameBase & {
      type: "tool.progress";
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
      verdict: ToolOutputView["verdict"];
      isError: boolean;
      text: string;
    })
  | (SessionWireFrameBase & {
      type: "tool.finished";
      turnId: string;
      attemptId: string;
      toolCallId: string;
      toolName: string;
      verdict: ToolOutputView["verdict"];
      isError: boolean;
      text: string;
    })
  // `turn.committed` is the replayable final turn state. Live preview frames
  // such as `tool.finished` and `assistant.delta` do not replace it.
  | (SessionWireFrameBase & {
      type: "turn.committed";
      turnId: string;
      attemptId: string;
      status: SessionWireCommittedStatus;
      assistantText: string;
      toolOutputs: ToolOutputView[];
    })
  | (SessionWireFrameBase & {
      type: "approval.requested";
      turnId: string;
      requestId: string;
      toolName: string;
      toolCallId: string;
      subject: string;
      detail?: string;
    })
  | (SessionWireFrameBase & {
      type: "approval.decided";
      turnId: string;
      requestId: string;
      decision: "approved" | "rejected";
      actor?: string;
      reason?: string;
    })
  | (SessionWireFrameBase & {
      type: "subagent.started";
      turnId: string;
      runId: string;
      delegate: string;
      kind: DelegationOutcomeKind;
      label?: string;
      lifecycle: "spawned" | "running";
    })
  | (SessionWireFrameBase & {
      type: "subagent.finished";
      turnId: string;
      runId: string;
      delegate: string;
      kind: DelegationOutcomeKind;
      status: "completed" | "failed" | "cancelled";
      summary?: string;
    })
  | (SessionWireFrameBase & {
      type: "session.closed";
      reason?: string;
    });
