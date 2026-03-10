import type { DecisionReceipt, ProposalDecision, ProposalEnvelope } from "../types.js";

export type BuildDecisionReceipt = (
  proposal: ProposalEnvelope,
  decision: ProposalDecision,
  policyBasis: string[],
  reasons: string[],
  turn: number,
  committedEffects?: DecisionReceipt["committedEffects"],
) => DecisionReceipt;
