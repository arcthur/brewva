import type { HostedTurnEnvelopeResult } from "../hosted/api.js";

// Bound the resume loop so a tool that keeps re-requesting approval cannot spin.
const MAX_DELEGATED_APPROVAL_RESUMES = 32;

/**
 * A delegated child runs autonomously with no interactive approver, yet its
 * effect boundary is already governed by its envelope (readonly-shared /
 * ephemeral_exec / patch-snapshot). Delegation IS the parent authorizing the
 * child to act within that envelope, so an approval-suspended child auto-approves
 * its own effectful tools inside the envelope and resumes. Each decision is still
 * recorded (actor = the delegation envelope) so the auto-approval stays auditable,
 * and the parent keeps final adoption authority (no-auto-apply). Without this an
 * effectful consult — e.g. a verifier running `exec` in its ephemeral sandbox —
 * suspends forever and is misreported as `subagent_thread_loop_suspended`
 * (game_4: the two readonly review consults ran clean, the verifier hung here).
 *
 * Only `reason === "approval"` suspensions are auto-resolved; a compaction
 * suspension is left for the caller, and any non-suspended status returns as-is.
 */
export async function resumeDelegatedApprovalsWithinEnvelope(input: {
  readonly initial: HostedTurnEnvelopeResult;
  readonly sessionId: string;
  readonly listPendingApprovals: (sessionId: string) => readonly { readonly requestId: string }[];
  readonly acceptApproval: (sessionId: string, requestId: string) => void;
  readonly resumeTurn: (resolveApproval: {
    readonly requestId: string;
  }) => Promise<HostedTurnEnvelopeResult>;
}): Promise<HostedTurnEnvelopeResult> {
  let output = input.initial;
  for (
    let resumes = 0;
    output.status === "suspended" &&
    output.reason === "approval" &&
    resumes < MAX_DELEGATED_APPROVAL_RESUMES;
    resumes += 1
  ) {
    const pending = input.listPendingApprovals(input.sessionId);
    const [firstPending] = pending;
    if (!firstPending) {
      break;
    }
    for (const request of pending) {
      input.acceptApproval(input.sessionId, request.requestId);
    }
    output = await input.resumeTurn({ requestId: firstPending.requestId });
  }
  return output;
}
