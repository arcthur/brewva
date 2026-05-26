import type { JsonRecord, JsonValue } from "./foundation.js";

export interface EvidenceRef {
  readonly id: string;
  readonly sourceType: string;
  readonly locator: string;
  readonly hash?: string;
  readonly createdAt: number;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly repoId?: string;
  readonly scope?: string;
  readonly modelVersion?: string;
  readonly toolVersion?: string;
  readonly originatingRuleIds?: readonly string[];
  readonly trustLevel?: string;
  readonly polarity?: string;
  readonly metadata?: Record<string, JsonValue>;
}

export type EffectCommitmentKind = "effect_commitment";

export interface EffectCommitmentProposal {
  readonly id: string;
  readonly kind: EffectCommitmentKind;
  readonly issuer: string;
  readonly subject: JsonRecord;
  readonly payload: JsonRecord;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly confidence?: number;
  readonly expiresAt?: number;
  readonly createdAt: number;
}

export type EffectCommitmentDecision = "accept" | "reject" | "defer";

export interface DecisionEffect {
  readonly kind: string;
  readonly target?: string;
  readonly metadata?: JsonRecord;
}

export interface DecisionReceipt {
  readonly proposalId: string;
  readonly decision: EffectCommitmentDecision;
  readonly policyBasis: string;
  readonly reasons: readonly string[];
  readonly committedEffects: readonly DecisionEffect[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly turn: string;
  readonly timestamp: number;
}

export interface DecideEffectCommitmentInput {
  readonly decision: "accept" | "deny" | "cancel";
  readonly actor: string;
  readonly reason?: string;
}

export interface DecideEffectCommitmentResult {
  readonly requestId: string;
  readonly decision: "accept" | "deny" | "cancel";
  readonly receipt?: DecisionReceipt;
}

export interface EffectCommitmentApprovalRequestedEventPayload {
  readonly requestId: string;
  readonly proposalId: string;
  readonly proposal: EffectCommitmentProposal;
}

export interface EffectCommitmentApprovalResolutionEventPayload {
  readonly requestId: string;
  readonly proposalId: string;
  readonly decision: "accept" | "deny" | "cancel";
  readonly actor: string;
  readonly reason?: string;
}

export interface EffectCommitmentApprovalConsumedEventPayload {
  readonly requestId: string;
  readonly proposalId: string;
  readonly commitmentId?: string;
}

export interface EffectCommitmentDecisionReceiptRecordedPayload {
  readonly receipt: DecisionReceipt;
}

export interface EffectCommitmentDiffPreviewFile {
  readonly path: string;
  readonly status?: string;
}

export interface EffectCommitmentDiffPreviewManifest {
  readonly proposalId: string;
  readonly files: readonly EffectCommitmentDiffPreviewFile[];
}

export interface EffectCommitmentDiffPreviewEdit {
  readonly kind: "diff";
  readonly path: string;
  readonly diff?: string;
  readonly error?: string;
}

export type EffectCommitmentDiffPreview =
  | EffectCommitmentDiffPreviewManifest
  | EffectCommitmentDiffPreviewEdit;

export interface EffectCommitmentListQuery {
  readonly sessionId?: string;
  readonly status?: string;
  readonly limit?: number;
}

export interface EffectCommitmentRequestListQuery {
  readonly sessionId?: string;
  readonly state?: EffectCommitmentRequestState;
}

export type EffectCommitmentRequestState =
  | "pending"
  | "accepted"
  | "denied"
  | "cancelled"
  | "consumed";

export interface EffectCommitmentProposalPayload {
  readonly proposal: EffectCommitmentProposal;
}

export interface EffectCommitmentRecord {
  readonly id: string;
  readonly proposalId: string;
  readonly state: string;
  readonly createdAt: number;
}

export interface EffectCommitmentRequestRecord {
  readonly id: string;
  readonly requestId: string;
  readonly proposalId: string;
  readonly state: EffectCommitmentRequestState;
  readonly createdAt: number;
  readonly toolName: string;
  readonly actor?: string;
  readonly reason?: string;
}

export interface PendingEffectCommitmentRequest {
  readonly requestId: string;
  readonly id?: string;
  readonly proposalId?: string;
  readonly proposal?: EffectCommitmentProposal;
  readonly state?: EffectCommitmentRequestState;
  readonly subject: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly boundary: string;
  readonly effects?: readonly string[];
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly turn?: number;
  readonly createdAt?: number;
  readonly defaultRisk?: string;
  readonly argsSummary?: string;
  readonly argsDigest?: string;
  readonly diffPreview?: EffectCommitmentDiffPreview;
}

export interface EffectAuthorityManifestFacts {
  readonly schema: "brewva.effect_authority_basis.v2";
  readonly requiresApproval: boolean;
  readonly effects: readonly string[];
  readonly invariantBasis: readonly string[];
  readonly overlayBasis: readonly string[];
  readonly runtimeBasis: readonly string[];
  readonly receiptBasis: readonly string[];
}

export function buildEffectAuthorityManifestBasis(
  input: Partial<EffectAuthorityManifestFacts>,
): EffectAuthorityManifestFacts {
  return Object.freeze({
    schema: "brewva.effect_authority_basis.v2",
    requiresApproval: false,
    effects: [],
    invariantBasis: [],
    overlayBasis: [],
    runtimeBasis: [],
    receiptBasis: [],
    ...input,
  });
}

export function decideEffectAuthorityManifest(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.freeze({ decision: "allow", ...input });
}
