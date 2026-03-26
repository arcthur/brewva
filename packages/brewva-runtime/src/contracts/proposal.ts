import type { ToolEffectClass, ToolGovernanceRisk } from "./governance.js";
import type { RuntimeResult } from "./shared.js";

export type ProposalKind = "effect_commitment";

export type ProposalDecision = "accept" | "reject" | "defer";

export type EvidenceSourceType =
  | "event"
  | "ledger"
  | "task"
  | "truth"
  | "workspace_artifact"
  | "operator_note"
  | "verification"
  | "tool_result";

export interface EvidenceRef {
  id: string;
  sourceType: EvidenceSourceType;
  locator: string;
  hash?: string;
  createdAt: number;
}

export interface EffectCommitmentProposalPayload {
  toolName: string;
  toolCallId: string;
  boundary: "effectful";
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  argsDigest: string;
  argsSummary?: string;
}

export type ProposalPayloadByKind = {
  effect_commitment: EffectCommitmentProposalPayload;
};

export type ProposalPayload = ProposalPayloadByKind[ProposalKind];

export interface ProposalEnvelope<K extends ProposalKind = ProposalKind> {
  id: string;
  kind: K;
  issuer: string;
  subject: string;
  payload: ProposalPayloadByKind[K];
  evidenceRefs: EvidenceRef[];
  confidence?: number;
  expiresAt?: number;
  createdAt: number;
}

export interface DecisionEffect {
  kind: string;
  details: Record<string, unknown>;
}

export interface DecisionReceipt {
  proposalId: string;
  decision: ProposalDecision;
  policyBasis: string[];
  reasons: string[];
  committedEffects: DecisionEffect[];
  evidenceRefs: EvidenceRef[];
  turn: number;
  timestamp: number;
}

export interface ProposalRecord<K extends ProposalKind = ProposalKind> {
  proposal: ProposalEnvelope<K>;
  receipt: DecisionReceipt;
}

export interface ProposalListQuery {
  kind?: ProposalKind;
  decision?: ProposalDecision;
  limit?: number;
}

export interface PendingEffectCommitmentRequest {
  requestId: string;
  proposalId: string;
  toolName: string;
  toolCallId: string;
  subject: string;
  boundary: "effectful";
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  argsDigest: string;
  argsSummary?: string;
  evidenceRefs: EvidenceRef[];
  turn: number;
  createdAt: number;
}

export interface DecideEffectCommitmentInput {
  decision: "accept" | "reject";
  actor?: string;
  reason?: string;
}

export type DecideEffectCommitmentResult = RuntimeResult<
  {
    request: PendingEffectCommitmentRequest;
    decision: "accept" | "reject";
  },
  "request_not_found" | "decision_required"
>;
