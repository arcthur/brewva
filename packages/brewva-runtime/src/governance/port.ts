import type { SessionCostSummary, VerificationLevel, VerificationReport } from "../types.js";

export interface GovernanceVerifySpecInput {
  sessionId: string;
  level: VerificationLevel;
  report: VerificationReport;
}

export interface GovernanceVerifySpecOutput {
  ok: boolean;
  reason?: string;
}

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

export interface GovernanceCompactionIntegrityOutput {
  ok: boolean;
  reason?: string;
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
}
