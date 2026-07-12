// Bound the resume loop so a tool that keeps re-requesting approval cannot spin.
const MAX_APPROVAL_RESUMES = 32;

/**
 * The minimal turn-result shape the envelope reads: a terminal/suspended status
 * and, when suspended, a reason. Both `HostedTurnEnvelopeResult` (the worker /
 * delegation lanes) and `HostedPromptTurnResult` (the embedded print lane)
 * satisfy it, so one primitive serves every backend.
 */
export interface EnvelopeTurnResult {
  readonly status: string;
  readonly reason?: string;
}

/**
 * How a governed envelope answers one pending approval on behalf of an absent
 * operator: `accept` and `deny` are authored decisions the loop applies and then
 * resumes past; `suspend` means the envelope declines to auto-decide, so the loop
 * stops and returns the still-suspended turn for a human (fail-closed).
 */
export type EnvelopeApprovalDecision = "accept" | "deny" | "suspend";

/**
 * The narrow view of a pending approval the envelope decider reads. Structurally
 * satisfied by the runtime's `PendingEffectCommitmentRequest`, so callers pass
 * `runtime.ops.proposals.requests.listPending(sessionId)` directly. `effects`
 * are the projected `ToolEffectClass` values of the proposed call.
 */
export interface EnvelopePendingApproval {
  readonly requestId: string;
  readonly turnId?: string;
  readonly effects?: readonly string[];
}

/**
 * A turn running with no interactive approver still has a governed effect
 * boundary — a delegated child's envelope (readonly-shared / ephemeral_exec /
 * patch-snapshot), a config-authored self-improve schedule's capability scope, or
 * an operator's declared unattended effect-class policy. Within that boundary an
 * approval-suspended turn auto-answers its own effectful tools and resumes; each
 * decision is still recorded (actor = the envelope) so the auto-approval stays
 * auditable, and adoption authority remains with the caller.
 *
 * The envelope's decision is supplied by `decide` (default: accept every pending
 * approval — the capability-scoped delegation and schedule lanes, whose boundary
 * is the session's grants, not an effect-class list). A `decide` that can return
 * `deny` must supply `denyApproval`. Any `suspend` decision halts the loop
 * fail-closed, leaving every request pending for a human.
 *
 * `turnId` scopes an envelope to approvals created by one exact turn. A scoped
 * unattended print run never decides a prior, concurrent, or legacy request
 * without a turn id; missing correlation fails closed. Omit it only for the
 * capability-scoped delegation/schedule lanes, whose boundary is the session's
 * grants and whose existing behavior is to decide every pending request.
 *
 * Only `reason === "approval"` suspensions are auto-resolved; a compaction
 * suspension is left for the caller, and any non-suspended status returns as-is.
 *
 * Returns the final turn plus `capExhausted`: true when the loop stopped because
 * it hit `MAX_APPROVAL_RESUMES` while still approval-suspended (a tool that keeps
 * re-requesting). A caller that treats "did not converge" as failure can then
 * distinguish cap exhaustion from a fail-closed decline.
 */
export interface EnvelopeResumeResult<TResult extends EnvelopeTurnResult> {
  readonly output: TResult;
  readonly capExhausted: boolean;
}

export async function resumeApprovalsWithinEnvelope<TResult extends EnvelopeTurnResult>(input: {
  readonly initial: TResult;
  readonly sessionId: string;
  readonly listPendingApprovals: (sessionId: string) => readonly EnvelopePendingApproval[];
  readonly acceptApproval: (sessionId: string, requestId: string) => void;
  readonly denyApproval?: (sessionId: string, requestId: string) => void;
  readonly decide?: (approval: EnvelopePendingApproval) => EnvelopeApprovalDecision;
  readonly turnId?: string;
  readonly resumeTurn: (resolveApproval: { readonly requestId: string }) => Promise<TResult>;
}): Promise<EnvelopeResumeResult<TResult>> {
  const decide = input.decide ?? ((): EnvelopeApprovalDecision => "accept");
  let output = input.initial;
  let resumes = 0;
  while (output.status === "suspended" && output.reason === "approval") {
    if (resumes >= MAX_APPROVAL_RESUMES) {
      // Hit the resume ceiling while still suspended: report cap exhaustion so a
      // caller can surface it as a non-zero, non-converged outcome.
      return { output, capExhausted: true };
    }
    // A scoped unattended print lane owns only approvals from its exact turn.
    // The projection carries turnId directly; do not reverse-engineer it from a
    // request-id encoding, and never accept legacy requests without the proof.
    const pending = input
      .listPendingApprovals(input.sessionId)
      .filter((approval) => input.turnId === undefined || approval.turnId === input.turnId);
    const [firstPending] = pending;
    if (!firstPending) {
      break;
    }
    const decisions = pending.map((approval) => ({
      requestId: approval.requestId,
      decision: decide(approval),
    }));
    // Fail-closed: if the envelope will not auto-decide any pending approval,
    // leave every request pending for a human and return the suspended turn.
    if (decisions.some((entry) => entry.decision === "suspend")) {
      break;
    }
    // A decider that denies must supply a deny sink; without one, never silently
    // accept — fall closed instead of applying a partial batch.
    if (!input.denyApproval && decisions.some((entry) => entry.decision === "deny")) {
      break;
    }
    for (const entry of decisions) {
      if (entry.decision === "deny") {
        input.denyApproval?.(input.sessionId, entry.requestId);
      } else {
        input.acceptApproval(input.sessionId, entry.requestId);
      }
    }
    output = await input.resumeTurn({ requestId: firstPending.requestId });
    resumes += 1;
  }
  return { output, capExhausted: false };
}
