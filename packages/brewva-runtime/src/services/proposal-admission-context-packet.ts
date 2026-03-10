import type { ContextPacketProposalPayload, DecisionReceipt, ProposalEnvelope } from "../types.js";
import type { BuildDecisionReceipt } from "./proposal-admission-shared.js";

export interface ContextPacketProposalCommitInput {
  proposal: ProposalEnvelope<"context_packet">;
  turn: number;
  buildDecisionReceipt: BuildDecisionReceipt;
}

export function commitContextPacketProposal({
  proposal,
  turn,
  buildDecisionReceipt,
}: ContextPacketProposalCommitInput): DecisionReceipt {
  const payload: ContextPacketProposalPayload = proposal.payload;
  const label = payload.label.trim();
  const content = payload.content.trim();
  const action = payload.action ?? "upsert";
  if (!label) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["context_packet_shape"],
      ["context_packet_missing_label"],
      turn,
    );
  }
  if (action === "revoke") {
    if (!payload.packetKey) {
      return buildDecisionReceipt(
        proposal,
        "reject",
        ["context_packet_shape"],
        ["context_packet_revoke_requires_packet_key"],
        turn,
      );
    }

    return buildDecisionReceipt(
      proposal,
      "accept",
      ["context_packet_admitted"],
      ["context_packet_revoked_for_injection"],
      turn,
      [
        {
          kind: "context_packet",
          details: {
            label,
            action,
            profile: payload.profile ?? null,
            scopeId: payload.scopeId ?? null,
            packetKey: payload.packetKey ?? null,
            expiresAt: proposal.expiresAt ?? null,
          },
        },
      ],
    );
  }
  if (!content) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["context_packet_shape"],
      ["context_packet_missing_content"],
      turn,
    );
  }

  return buildDecisionReceipt(
    proposal,
    "accept",
    ["context_packet_admitted"],
    ["context_packet_available_for_injection"],
    turn,
    [
      {
        kind: "context_packet",
        details: {
          label,
          action,
          profile: payload.profile ?? null,
          scopeId: payload.scopeId ?? null,
          packetKey: payload.packetKey ?? null,
          expiresAt: proposal.expiresAt ?? null,
        },
      },
    ],
  );
}
