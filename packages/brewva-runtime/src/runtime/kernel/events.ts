import type { ResolvedToolAuthority } from "./policy/public-contract.js";
import type { ApprovalRequest, ToolCallProposal, ToolExecutionResult } from "./port.js";

export interface ToolAuthorityDecisionPayload {
  readonly normalizedToolName: string;
  readonly source: ResolvedToolAuthority["source"];
  readonly boundary: ResolvedToolAuthority["boundary"];
  readonly requiresApproval: boolean;
  readonly actionClass?: ResolvedToolAuthority["actionClass"];
  readonly riskLevel?: ResolvedToolAuthority["riskLevel"];
  readonly defaultAdmission?: ResolvedToolAuthority["defaultAdmission"];
  readonly maxAdmission?: ResolvedToolAuthority["maxAdmission"];
  readonly effectiveAdmission?: ResolvedToolAuthority["effectiveAdmission"];
  readonly effects: readonly string[];
  readonly recoveryPreparation: ResolvedToolAuthority["recoveryPreparation"];
  readonly receiptPolicy?: ResolvedToolAuthority["receiptPolicy"];
  readonly recoveryPolicy?: ResolvedToolAuthority["recoveryPolicy"];
  readonly policyBasis: readonly string[];
  readonly manifestBasis: ResolvedToolAuthority["manifestBasis"];
}

export interface ToolProposedPayload {
  readonly commitmentId: string;
  readonly call: ToolCallProposal;
  readonly authority: ToolAuthorityDecisionPayload;
}

export interface ToolCommittedPayload {
  readonly commitmentId: string;
  readonly call: ToolCallProposal;
  readonly result: ToolExecutionResult;
}

export interface ToolAbortedPayload {
  readonly commitmentId: string;
  readonly reason: string;
  readonly call?: ToolCallProposal;
  readonly attemptedCall?: ToolCallProposal;
  readonly authority?: ToolAuthorityDecisionPayload;
}

export interface ApprovalRequestedPayload extends ApprovalRequest {
  readonly authority: ToolAuthorityDecisionPayload;
}

export interface ApprovalDecidedPayload {
  readonly id: string;
  readonly decision: "accept" | "deny" | "cancel";
  readonly actor?: string;
  readonly reason?: string;
}
