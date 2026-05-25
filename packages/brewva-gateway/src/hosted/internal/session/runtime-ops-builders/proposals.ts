import type { DecisionReceipt } from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildProposalsRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["proposals"] {
  return {
    requests: {
      listPending: () => [],
      list: () => [],
      decide(sessionId, requestId, input) {
        ctx.emit(sessionId, "approval.decided", {
          requestId,
          decision: input.decision,
          actor: input.actor,
          reason: input.reason,
        });
        return { requestId, decision: input.decision };
      },
    },
    proposals: {
      list: () => [],
      submit(sessionId, proposal) {
        const receipt: DecisionReceipt = {
          proposalId: proposal.id,
          decision: "defer",
          policyBasis: "runtime_ops",
          reasons: [],
          committedEffects: [],
          evidenceRefs: proposal.evidenceRefs,
          turn: String(Date.now()),
          timestamp: Date.now(),
        };
        ctx.emit(sessionId, "proposal.submitted", { proposal, receipt });
        return receipt;
      },
    },
    governance: {
      turnDecisionRecorded: ctx.recordInputPayload("proposal.turn_decision_recorded"),
    },
  };
}
