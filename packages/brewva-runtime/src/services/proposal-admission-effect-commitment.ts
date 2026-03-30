import type {
  DecisionReceipt,
  EffectCommitmentProposal,
  ProposalDecision,
  ToolEffectClass,
  ToolGovernanceDescriptor,
} from "../contracts/index.js";
import type { ResolvedToolAuthority } from "../governance/tool-governance.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { BuildDecisionReceipt } from "./proposal-admission-shared.js";

export interface AuthorizeEffectCommitmentInput {
  sessionId: string;
  proposal: EffectCommitmentProposal;
  descriptor: ToolGovernanceDescriptor;
  turn: number;
}

export interface EffectCommitmentAuthorizationDecision {
  decision: ProposalDecision;
  requestId?: string;
  policyBasis: string[];
  reasons: string[];
  committedEffects?: DecisionReceipt["committedEffects"];
}

interface EffectCommitmentProposalCommitInput {
  sessionId: string;
  proposal: EffectCommitmentProposal;
  turn: number;
  buildDecisionReceipt: BuildDecisionReceipt;
  resolveToolAuthority: (toolName: string) => ResolvedToolAuthority;
  authorize: (input: AuthorizeEffectCommitmentInput) => EffectCommitmentAuthorizationDecision;
}

function sameEffects(left: readonly ToolEffectClass[], right: readonly ToolEffectClass[]): boolean {
  const leftValues = [...new Set(left)].toSorted();
  const rightValues = [...new Set(right)].toSorted();
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

export function commitEffectCommitmentProposal({
  sessionId,
  proposal,
  turn,
  buildDecisionReceipt,
  resolveToolAuthority,
  authorize,
}: EffectCommitmentProposalCommitInput): DecisionReceipt {
  const payload = proposal.payload;
  const toolName = normalizeToolName(payload.toolName);
  if (!toolName) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_shape"],
      ["effect_commitment_missing_tool_name"],
      turn,
    );
  }

  if (!payload.toolCallId.trim()) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_shape"],
      ["effect_commitment_missing_tool_call_id"],
      turn,
    );
  }

  if (!payload.argsDigest.trim()) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_shape"],
      [`effect_commitment_missing_args_digest:${toolName}`],
      turn,
    );
  }

  if (payload.boundary !== "effectful") {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_boundary"],
      [`effect_commitment_requires_effectful_boundary:${toolName}`],
      turn,
    );
  }

  const authority = resolveToolAuthority(toolName);
  const descriptor = authority.descriptor;
  if (!descriptor) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["tool_governance_metadata"],
      [`effect_commitment_missing_governance_descriptor:${toolName}`],
      turn,
    );
  }
  if (authority.source !== "exact" && authority.source !== "registry") {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["tool_governance_metadata"],
      [`effect_commitment_requires_exact_governance_descriptor:${toolName}`],
      turn,
    );
  }

  if (authority.boundary !== "effectful" || !authority.requiresApproval) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_boundary"],
      [`effect_commitment_tool_not_approval_bound:${toolName}`],
      turn,
    );
  }

  if (!sameEffects(payload.effects, descriptor.effects)) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["effect_commitment_effects"],
      [`effect_commitment_effects_mismatch:${toolName}`],
      turn,
    );
  }

  const authorization = authorize({
    sessionId,
    proposal,
    descriptor,
    turn,
  });
  const decision = normalizeDecision(authorization.decision);
  const policyBasis = normalizeStringList(
    [
      "effect_commitment",
      "tool_governance_descriptor",
      "effectful_boundary",
      ...(authorization.policyBasis ?? []),
    ],
    "effect_commitment_policy",
  );
  const reasons = normalizeStringList(
    authorization.reasons,
    `effect_commitment_${decision}:${toolName}`,
  );

  if (decision !== "accept") {
    return buildDecisionReceipt(proposal, decision, policyBasis, reasons, turn);
  }

  return buildDecisionReceipt(proposal, "accept", policyBasis, reasons, turn, [
    {
      kind: "tool_commitment",
      details: {
        toolName,
        toolCallId: payload.toolCallId,
        boundary: payload.boundary,
        effects: [...descriptor.effects],
        defaultRisk: descriptor.defaultRisk ?? null,
        argsDigest: payload.argsDigest,
        argsSummary: payload.argsSummary ?? null,
      },
    },
    ...(authorization.committedEffects ?? []),
  ]);
}

function normalizeDecision(value: unknown): ProposalDecision {
  if (value === "accept" || value === "reject" || value === "defer") {
    return value;
  }
  return "reject";
}

function normalizeStringList(values: readonly string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return [fallback];
  }
  return [...new Set(normalized)];
}
