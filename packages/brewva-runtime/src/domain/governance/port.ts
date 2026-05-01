import type { VerificationLevel } from "../../core/shared.js";
import type { SessionCostSummary } from "../cost/types.js";
import type { EffectCommitmentProposal, ProposalDecision } from "../proposals/types.js";
import type { VerificationReport } from "../verification/types.js";

export interface GovernanceVerifySpecInput {
  sessionId: string;
  level: VerificationLevel;
  report: VerificationReport;
}

export type GovernanceVerifySpecOutput = { ok: true } | { ok: false; reason: string };

export interface GovernanceCostAnomalyInput {
  sessionId: string;
  summary: SessionCostSummary;
}

export interface GovernanceCostAnomalyOutput {
  anomaly: boolean;
  reason?: string;
}

export interface GovernanceCompactionIntegrityInput {
  sessionId: string;
  summary: string;
  violations: string[];
}

export type GovernanceCompactionIntegrityOutput = { ok: true } | { ok: false; reason: string };

export interface GovernanceAuthorizeEffectCommitmentInput {
  sessionId: string;
  proposal: EffectCommitmentProposal;
  turn: number;
}

export interface GovernanceAuthorizeEffectCommitmentOutput {
  decision: ProposalDecision;
  reason?: string;
  reasons?: string[];
  policyBasis?: string[];
}

export interface GovernancePort {
  verifySpec?(
    input: GovernanceVerifySpecInput,
  ): GovernanceVerifySpecOutput | Promise<GovernanceVerifySpecOutput>;
  detectCostAnomaly?(
    input: GovernanceCostAnomalyInput,
  ): GovernanceCostAnomalyOutput | Promise<GovernanceCostAnomalyOutput>;
  checkCompactionIntegrity?(
    input: GovernanceCompactionIntegrityInput,
  ): GovernanceCompactionIntegrityOutput | Promise<GovernanceCompactionIntegrityOutput>;
  authorizeEffectCommitment?(
    input: GovernanceAuthorizeEffectCommitmentInput,
  ): GovernanceAuthorizeEffectCommitmentOutput;
}
