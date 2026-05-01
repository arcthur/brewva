import type { BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { RecoveryPendingFamily, RecoveryPostureMode } from "../context/api.js";
import type { PendingEffectCommitmentRequest } from "../proposals/api.js";
import type { ActiveSkillRuntimeState, SkillCompletionFailureRecord } from "../skills/api.js";
import type { IntegrityStatus } from "./integrity.js";
import type { OpenToolCallRecord, SessionHydrationState } from "./types.js";
import type { SessionWireFrame } from "./wire.js";

export type SessionLifecycleSummaryKind =
  | "cold"
  | "active"
  | "idle"
  | "blocked"
  | "recovering"
  | "degraded"
  | "closed";

export type SessionLifecycleExecutionSnapshot =
  | { kind: "idle" }
  | { kind: "model_streaming" }
  | {
      kind: "tool_executing";
      toolCallId: BrewvaToolCallId;
      toolName: BrewvaToolName;
    }
  | {
      kind: "waiting_approval";
      requestId: string | null;
      toolCallId: BrewvaToolCallId | null;
      toolName: BrewvaToolName | null;
      reason: string | null;
      detail: string | null;
    }
  | {
      kind: "recovering";
      reason: string | null;
      detail: string | null;
      family: RecoveryPendingFamily | null;
    }
  | {
      kind: "terminated";
      reason: string | null;
    };

export interface SessionLifecycleTransitionSnapshot {
  reason: string;
  status: string;
  family: RecoveryPendingFamily | null;
  sourceEventId: string | null;
  sourceEventType: string | null;
}

export interface SessionLifecycleRecoverySnapshot {
  mode: RecoveryPostureMode;
  latestReason: string | null;
  latestStatus: string | null;
  pendingFamily: RecoveryPendingFamily | null;
  degradedReason: string | null;
  duplicateSideEffectSuppressionCount: number;
  latestSourceEventId: string | null;
  latestSourceEventType: string | null;
  recentTransitions: SessionLifecycleTransitionSnapshot[];
}

export interface SessionLifecycleSkillSnapshot {
  posture: "none" | "active" | "repair_required";
  activeSkillName: string | null;
  activeSkillState?: ActiveSkillRuntimeState;
  latestFailure?: SkillCompletionFailureRecord;
}

export interface SessionLifecycleApprovalSnapshot {
  status: "idle" | "pending";
  pendingCount: number;
  requestId: string | null;
  toolCallId: BrewvaToolCallId | null;
  toolName: BrewvaToolName | null;
  subject: string | null;
}

export interface SessionLifecycleToolingSnapshot {
  openToolCalls: OpenToolCallRecord[];
}

export interface SessionLifecycleSummarySnapshot {
  kind: SessionLifecycleSummaryKind;
  reason: string | null;
  detail: string | null;
}

export interface SessionLifecycleSnapshot {
  hydration: SessionHydrationState;
  execution: SessionLifecycleExecutionSnapshot;
  recovery: SessionLifecycleRecoverySnapshot;
  skill: SessionLifecycleSkillSnapshot;
  approval: SessionLifecycleApprovalSnapshot;
  tooling: SessionLifecycleToolingSnapshot;
  integrity: IntegrityStatus;
  summary: SessionLifecycleSummarySnapshot;
}

export interface SessionLifecycleSnapshotBuildInput {
  sessionId: string;
  hydration: SessionHydrationState;
  integrity: IntegrityStatus;
  recovery: SessionLifecycleRecoverySnapshot;
  activeSkillState?: ActiveSkillRuntimeState;
  latestSkillFailure?: SkillCompletionFailureRecord;
  pendingApprovals: PendingEffectCommitmentRequest[];
  openToolCalls: OpenToolCallRecord[];
  frames: readonly SessionWireFrame[];
}
