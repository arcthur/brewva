import type {
  EffectProjectionWarning,
  EffectRecoverability,
  EffectVisibility,
  ToolActionClass,
  ToolEffectClass,
  ToolRecoveryPreparation,
} from "../../governance/api.js";

export interface EffectCommitmentSummary {
  toolName: string;
  effects: ToolEffectClass[];
  recoveryPreparation: ToolRecoveryPreparation;
  recoverability: EffectRecoverability;
  visibility: EffectVisibility;
}

export interface EffectCommitmentAttempt extends EffectCommitmentSummary {
  toolCallId?: string;
  eventId: string;
  decision: "allow" | "block" | "defer" | "unknown";
}

export interface EffectAuthorityDecisionSummary extends EffectCommitmentAttempt {
  actionClass?: ToolActionClass;
  requiresApproval: boolean;
  reason?: string;
}

export interface EffectExecutionSummary extends EffectCommitmentSummary {
  toolCallId?: string;
  receiptId?: string;
  ledgerId?: string;
  patchSetId?: string;
  rollbackRef?: string;
  rollbackAvailable: boolean;
  source: "tool_result" | "mutation_receipt";
  channelSuccess?: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
}

export interface EffectRecoveryPreparationSummary extends EffectCommitmentSummary {
  toolCallId?: string;
  receiptId: string;
  eventId: string;
}

export interface EffectRecoverySummary {
  kind: "rollback" | "redo";
  receiptId: string;
  patchSetId?: string;
  toolName?: string;
  status: string;
  reason?: string;
  eventId: string;
}

export interface EffectTurnTransitionSummary {
  reason: string;
  status: string;
  family: string;
  eventId: string;
}

export interface TurnEffectCommitmentProjection {
  sessionId: string;
  turnId: string;
  runtimeTurn: number;
  declared: EffectCommitmentSummary[];
  attempted: EffectCommitmentAttempt[];
  decisions: EffectAuthorityDecisionSummary[];
  prepared: EffectRecoveryPreparationSummary[];
  executed: EffectExecutionSummary[];
  recovery: EffectRecoverySummary[];
  turnTransitions: EffectTurnTransitionSummary[];
  warnings: EffectProjectionWarning[];
  modelDigest: string;
}

export interface DeriveTurnEffectCommitmentProjectionInput {
  sessionId: string;
  turnId: string;
  runtimeTurn: number;
  events: readonly import("../../../events/types.js").BrewvaEventRecord[];
}

export interface RenderTurnConsequenceDigestOptions {
  maxChars?: number;
}
