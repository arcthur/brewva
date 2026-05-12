import type { BrewvaToolCallId, BrewvaToolName } from "../../core/identifiers.js";
import type { RuntimeResult } from "../../core/runtime-result.js";
import type { EvidenceRef } from "../evidence/api.js";
import type {
  EffectAuthorityManifestBasis,
  ToolEffectClass,
  ToolGovernanceRisk,
} from "../governance/api.js";

export type ProposalDecision = "accept" | "reject" | "defer";

export interface EffectCommitmentDiffPreviewFile {
  path: string;
  displayPath?: string;
  diff: string;
  action?: string;
  additions?: number;
  deletions?: number;
  movePath?: string;
}

export interface EffectCommitmentDiffPreview {
  kind: "diff";
  path?: string;
  diff?: string;
  files?: EffectCommitmentDiffPreviewFile[];
  error?: string;
}

export interface EffectCommitmentProposalPayload {
  toolName: BrewvaToolName;
  toolCallId: BrewvaToolCallId;
  boundary: "effectful";
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  argsDigest: string;
  argsSummary?: string;
  diffPreview?: EffectCommitmentDiffPreview;
  manifestBasis?: EffectAuthorityManifestBasis;
}

export interface EffectCommitmentProposal {
  id: string;
  kind: "effect_commitment";
  issuer: string;
  subject: string;
  payload: EffectCommitmentProposalPayload;
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
  manifestBasis?: EffectAuthorityManifestBasis;
  turn: number;
  timestamp: number;
}

export interface EffectCommitmentDecisionReceiptRecordedPayload {
  proposal: EffectCommitmentProposal;
  receipt: DecisionReceipt;
}

export interface EffectCommitmentApprovalRequestedEventPayload {
  requestId: string;
  proposalId?: string;
  toolName?: BrewvaToolName;
  toolCallId?: BrewvaToolCallId;
  subject?: string;
  boundary?: "effectful";
  effects?: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  argsSummary?: string;
  diffPreview?: EffectCommitmentDiffPreview;
  proposal?: EffectCommitmentProposal;
}

export interface EffectCommitmentApprovalResolutionEventPayload {
  requestId: string;
  proposalId?: string;
  toolName?: BrewvaToolName;
  toolCallId?: BrewvaToolCallId;
  decision?: Extract<ProposalDecision, "accept" | "reject">;
  actor?: string;
  reason?: string;
}

export interface EffectCommitmentApprovalConsumedEventPayload extends EffectCommitmentApprovalResolutionEventPayload {
  ledgerId?: string;
  verdict?: "pass" | "fail" | "inconclusive";
  channelSuccess?: boolean;
}

export interface EffectCommitmentRecord {
  proposal: EffectCommitmentProposal;
  receipt: DecisionReceipt;
}

export interface EffectCommitmentListQuery {
  decision?: ProposalDecision;
  limit?: number;
}

export type EffectCommitmentRequestState = "pending" | "accepted" | "rejected" | "consumed";

export interface PendingEffectCommitmentRequest {
  requestId: string;
  proposalId: string;
  toolName: BrewvaToolName;
  toolCallId: BrewvaToolCallId;
  subject: string;
  boundary: "effectful";
  effects: ToolEffectClass[];
  defaultRisk?: ToolGovernanceRisk;
  argsDigest: string;
  argsSummary?: string;
  diffPreview?: EffectCommitmentDiffPreview;
  evidenceRefs: EvidenceRef[];
  turn: number;
  createdAt: number;
}

export interface EffectCommitmentRequestRecord extends PendingEffectCommitmentRequest {
  state: EffectCommitmentRequestState;
  actor?: string;
  reason?: string;
  updatedAt: number;
}

export interface EffectCommitmentRequestListQuery {
  state?: EffectCommitmentRequestState;
  limit?: number;
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
