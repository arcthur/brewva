import type {
  DecisionReceipt,
  EffectCommitmentProposal,
  ProposalDecision,
} from "../contracts/index.js";

export type BuildDecisionReceipt = (
  proposal: EffectCommitmentProposal,
  decision: ProposalDecision,
  policyBasis: string[],
  reasons: string[],
  turn: number,
  committedEffects?: DecisionReceipt["committedEffects"],
) => DecisionReceipt;
