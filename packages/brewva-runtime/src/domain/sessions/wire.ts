import type { BrewvaSessionId, BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { DelegationOutcomeKind } from "../delegation/api.js";

export const SESSION_WIRE_SCHEMA = "brewva.session-wire.v2" as const;

export type SessionWireSource = "replay" | "live";
export type SessionWireDurability = "durable" | "cache";
export type SessionWireTurnTrigger =
  | "user"
  | "schedule"
  | "heartbeat"
  | "channel"
  | "recovery"
  | "subagent";
export type SessionWireAttemptReason =
  | "initial"
  | "output_budget_escalation"
  | "compaction_retry"
  | "provider_fallback_retry"
  | "max_output_recovery"
  | "reasoning_revert_resume";
export type SessionWireTransitionFamily =
  | "context"
  | "output_budget"
  | "approval"
  | "delegation"
  | "interrupt"
  | "recovery";
export type SessionWireTransitionStatus = "entered" | "completed" | "failed" | "skipped";
export type SessionWireCommittedStatus = "completed" | "failed" | "cancelled";
export type SessionTurnTransitionReason =
  | "compaction_gate_blocked"
  | "compaction_retry"
  | "effect_commitment_pending"
  | "output_budget_escalation"
  | "provider_fallback_retry"
  | "max_output_recovery"
  | "reasoning_revert_resume"
  | "subagent_delivery_pending"
  | "wal_recovery_resume"
  | "user_submit_interrupt"
  | "signal_interrupt"
  | "timeout_interrupt";
export type SessionWireStatusState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "restarting"
  | "error"
  | "closed";

export interface ContextStatusView {
  tokensUsed: number;
  tokensTotal: number;
  effectiveTokensTotal?: number;
  tokensRemaining: number;
  autoCompactLimitTokens?: number;
  controllableBaselineTokens?: number;
  controllableTokensUsed?: number;
  controllableTokensTotal?: number;
  controllableTokensRemaining?: number;
  controllableContextRemainingRatio?: number | null;
  tokensUntilForcedCompact: number;
  predictedTurnGrowthTokens: number;
  tokensUntilPredictedOverflow: number;
  predictedOverflow: boolean;
  usageRatio: number;
  hardLimitRatio: number;
  compactionThresholdRatio: number;
  compactionAdvised: boolean;
  forcedCompaction: boolean;
}

export interface ToolOutputDisplayView {
  summaryText?: string;
  detailsText?: string;
  rawText?: string;
}

export interface ToolOutputView {
  toolCallId: BrewvaToolCallId;
  toolName: BrewvaToolName;
  verdict: "pass" | "fail" | "inconclusive";
  isError: boolean;
  text: string;
  display?: ToolOutputDisplayView;
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

export interface SessionTurnTransitionPayload {
  reason: SessionTurnTransitionReason;
  status: SessionWireTransitionStatus;
  sequence: number;
  family: SessionWireTransitionFamily;
  attempt: number | null;
  sourceEventId: string | null;
  sourceEventType: string | null;
  error: string | null;
  breakerOpen: boolean;
  model: string | null;
}

export interface SessionWireFrameBase {
  schema: typeof SESSION_WIRE_SCHEMA;
  sessionId: BrewvaSessionId;
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
      contextStatus?: ContextStatusView;
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
      toolCallId: BrewvaToolCallId;
      toolName: BrewvaToolName;
    })
  | (SessionWireFrameBase & {
      type: "tool.progress";
      turnId: string;
      attemptId: string;
      toolCallId: BrewvaToolCallId;
      toolName: BrewvaToolName;
      verdict: ToolOutputView["verdict"];
      isError: boolean;
      text: string;
      display?: ToolOutputDisplayView;
    })
  | (SessionWireFrameBase & {
      type: "tool.finished";
      turnId: string;
      attemptId: string;
      toolCallId: BrewvaToolCallId;
      toolName: BrewvaToolName;
      verdict: ToolOutputView["verdict"];
      isError: boolean;
      text: string;
      display?: ToolOutputDisplayView;
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
      toolName: BrewvaToolName;
      toolCallId: BrewvaToolCallId;
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
