import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type {
  BrewvaEventRecord,
  DecisionReceipt,
  EvidenceRef,
  ProposalDecision,
  ProposalEnvelope,
  ProposalKind,
  ProposalListQuery,
  ProposalRecord,
  ToolGovernanceDescriptor,
} from "../types.js";
import {
  commitEffectCommitmentProposal,
  type AuthorizeEffectCommitmentInput,
  type EffectCommitmentAuthorizationDecision,
} from "./proposal-admission-effect-commitment.js";

export interface ProposalAdmissionServiceOptions {
  listDecisionReceiptEvents: (sessionId: string) => BrewvaEventRecord[];
  recordEvent: RuntimeKernelContext["recordEvent"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  resolveToolGovernanceDescriptor: (toolName: string) => ToolGovernanceDescriptor | undefined;
  effectCommitmentAuthorizer: (
    input: AuthorizeEffectCommitmentInput,
  ) => EffectCommitmentAuthorizationDecision;
}

export class ProposalAdmissionService {
  private readonly listDecisionReceiptEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly resolveToolGovernanceDescriptor: (
    toolName: string,
  ) => ToolGovernanceDescriptor | undefined;
  private readonly authorizeEffectCommitment: (
    input: AuthorizeEffectCommitmentInput,
  ) => EffectCommitmentAuthorizationDecision;

  constructor(options: ProposalAdmissionServiceOptions) {
    this.listDecisionReceiptEvents = (sessionId) => options.listDecisionReceiptEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.resolveToolGovernanceDescriptor = (toolName) =>
      options.resolveToolGovernanceDescriptor(toolName);
    this.authorizeEffectCommitment = (input) => options.effectCommitmentAuthorizer(input);
  }

  submitProposal<K extends ProposalKind>(
    sessionId: string,
    proposal: ProposalEnvelope<K>,
  ): DecisionReceipt {
    const normalizedProposal = this.normalizeProposalEnvelope(proposal);
    const turn = this.getCurrentTurn(sessionId);

    this.recordEvent({
      sessionId,
      type: PROPOSAL_RECEIVED_EVENT_TYPE,
      turn,
      payload: {
        proposalId: normalizedProposal.id,
        kind: normalizedProposal.kind,
        issuer: normalizedProposal.issuer,
        subject: normalizedProposal.subject,
        evidenceCount: normalizedProposal.evidenceRefs.length,
        expiresAt: normalizedProposal.expiresAt ?? null,
      },
    });

    const receipt = this.decideProposal(sessionId, normalizedProposal, turn);

    this.recordEvent({
      sessionId,
      type: PROPOSAL_DECIDED_EVENT_TYPE,
      turn: receipt.turn,
      payload: {
        proposalId: normalizedProposal.id,
        kind: normalizedProposal.kind,
        decision: receipt.decision,
        policyBasis: [...receipt.policyBasis],
        reasons: [...receipt.reasons],
      },
    });
    this.recordEvent({
      sessionId,
      type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
      turn: receipt.turn,
      payload: {
        proposal: normalizedProposal,
        receipt,
      },
    });

    return structuredClone(receipt);
  }

  listProposalRecords(sessionId: string, query: ProposalListQuery = {}): ProposalRecord[] {
    const records = this.listDecisionReceiptEvents(sessionId)
      .map((event) => this.readProposalRecord(event.payload))
      .filter((record): record is ProposalRecord => record !== null)
      .filter((record) => (query.kind ? record.proposal.kind === query.kind : true))
      .filter((record) => (query.decision ? record.receipt.decision === query.decision : true))
      .toSorted((left, right) => {
        if (right.receipt.timestamp !== left.receipt.timestamp) {
          return right.receipt.timestamp - left.receipt.timestamp;
        }
        if (right.proposal.createdAt !== left.proposal.createdAt) {
          return right.proposal.createdAt - left.proposal.createdAt;
        }
        return right.proposal.id.localeCompare(left.proposal.id);
      });

    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      return records.slice(0, Math.floor(query.limit)).map((record) => structuredClone(record));
    }
    return records.map((record) => structuredClone(record));
  }

  getLatestProposalRecord(
    sessionId: string,
    kind: ProposalKind,
    decision?: ProposalDecision,
  ): ProposalRecord | undefined {
    return this.listProposalRecords(sessionId, { kind, decision, limit: 1 })[0];
  }

  private readProposalRecord(payload: unknown): ProposalRecord | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const candidate = payload as { proposal?: ProposalEnvelope; receipt?: DecisionReceipt };
    if (!candidate.proposal || !candidate.receipt) {
      return null;
    }
    return {
      proposal: structuredClone(candidate.proposal),
      receipt: structuredClone(candidate.receipt),
    };
  }

  private normalizeProposalEnvelope<K extends ProposalKind>(
    proposal: ProposalEnvelope<K>,
  ): ProposalEnvelope<K> {
    return {
      ...proposal,
      id: proposal.id.trim(),
      issuer: proposal.issuer.trim(),
      subject: proposal.subject.trim(),
      payload: proposal.payload,
      evidenceRefs: this.normalizeEvidenceRefs(proposal.evidenceRefs),
      confidence:
        typeof proposal.confidence === "number" && Number.isFinite(proposal.confidence)
          ? Math.max(0, Math.min(1, proposal.confidence))
          : undefined,
      expiresAt:
        typeof proposal.expiresAt === "number" && Number.isFinite(proposal.expiresAt)
          ? Math.max(0, Math.floor(proposal.expiresAt))
          : undefined,
      createdAt: Math.max(0, Math.floor(proposal.createdAt)),
    };
  }

  private normalizeEvidenceRefs(evidenceRefs: EvidenceRef[]): EvidenceRef[] {
    return evidenceRefs
      .filter(
        (entry) =>
          typeof entry.id === "string" &&
          entry.id.trim().length > 0 &&
          typeof entry.sourceType === "string" &&
          entry.sourceType.trim().length > 0 &&
          typeof entry.locator === "string" &&
          entry.locator.trim().length > 0 &&
          typeof entry.createdAt === "number" &&
          Number.isFinite(entry.createdAt),
      )
      .map((entry) => ({
        id: entry.id.trim(),
        sourceType: entry.sourceType,
        locator: entry.locator.trim(),
        hash:
          typeof entry.hash === "string" && entry.hash.trim().length > 0 ? entry.hash : undefined,
        createdAt: Math.max(0, Math.floor(entry.createdAt)),
      }));
  }

  private decideProposal(
    sessionId: string,
    proposal: ProposalEnvelope,
    turn: number,
  ): DecisionReceipt {
    if (!proposal.id || !proposal.issuer || !proposal.subject) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["proposal_shape"],
        ["proposal_missing_required_identity_fields"],
        turn,
      );
    }
    if (proposal.evidenceRefs.length === 0) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["evidence_required"],
        ["proposal_missing_evidence"],
        turn,
      );
    }
    if (typeof proposal.expiresAt === "number" && proposal.expiresAt < Date.now()) {
      return this.buildDecisionReceipt(
        proposal,
        "reject",
        ["proposal_ttl"],
        ["proposal_expired"],
        turn,
      );
    }
    return commitEffectCommitmentProposal({
      sessionId,
      proposal,
      turn,
      resolveToolGovernanceDescriptor: (toolName) => this.resolveToolGovernanceDescriptor(toolName),
      buildDecisionReceipt: (
        nextProposal,
        decision,
        policyBasis,
        reasons,
        nextTurn,
        committedEffects = [],
      ) =>
        this.buildDecisionReceipt(
          nextProposal,
          decision,
          policyBasis,
          reasons,
          nextTurn,
          committedEffects,
        ),
      authorize: (input) => this.authorizeEffectCommitment(input),
    });
  }

  private buildDecisionReceipt(
    proposal: ProposalEnvelope,
    decision: ProposalDecision,
    policyBasis: string[],
    reasons: string[],
    turn: number,
    committedEffects: DecisionReceipt["committedEffects"] = [],
  ): DecisionReceipt {
    return {
      proposalId: proposal.id,
      decision,
      policyBasis,
      reasons,
      committedEffects,
      evidenceRefs: structuredClone(proposal.evidenceRefs),
      turn,
      timestamp: Date.now(),
    };
  }
}
