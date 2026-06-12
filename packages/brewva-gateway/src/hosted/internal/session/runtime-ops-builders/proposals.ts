import { canonicalEventToFourPortRuntimeEvent } from "@brewva/brewva-tools/runtime-port";
import type { DecisionReceipt } from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";
import { buildApprovalRequestsForOptionalSession } from "./proposal-requests/read-model.js";

export function buildProposalsRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["proposals"] {
  return {
    requests: {
      listPending: (sessionId) =>
        buildApprovalRequestsForOptionalSession(ctx, sessionId).filter(
          (request) => request.state === "pending",
        ),
      list: (sessionId, query) => buildApprovalRequestsForOptionalSession(ctx, sessionId, query),
      decide(sessionId, requestId, input) {
        // The kernel is the only canonical approval decision writer (kernel
        // clock, first-writer-wins); the gateway routes and never authors
        // authority events itself.
        const receipt = ctx.runtime.kernel.recordApprovalDecision({
          sessionId,
          requestId,
          decision: input.decision,
          actor: input.actor,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        ctx.publishEvent(canonicalEventToFourPortRuntimeEvent(receipt.event));
        return {
          requestId: receipt.requestId,
          decision: receipt.decision,
          applied: receipt.applied,
          ...(receipt.priorState !== undefined ? { alreadyDecidedState: receipt.priorState } : {}),
        };
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
