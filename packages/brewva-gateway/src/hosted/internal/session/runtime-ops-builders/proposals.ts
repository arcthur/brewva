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
        const request = buildApprovalRequestsForOptionalSession(ctx, sessionId).find(
          (entry) => entry.requestId === requestId,
        );
        if (!request || request.state !== "pending") {
          throw new Error(
            request
              ? `approval_request_not_pending:${requestId}:${request.state}`
              : `approval_request_not_found:${requestId}`,
          );
        }
        ctx.emit(sessionId, "approval.decided", {
          id: requestId,
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
