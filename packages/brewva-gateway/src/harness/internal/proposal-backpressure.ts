/**
 * Proposal-lane backpressure counter (RFC optimizer-last-hop Phase 4, demand-
 * gated). The human gate has no aging/consumption-SLA design yet; before
 * building one, land ONLY a counter so a real backlog can be observed. This is
 * pure and derives a view — it grants no authority and expires nothing.
 *
 * It counts the ONE proposal lane with a truthful age + consumption model:
 * harness candidates evaluated but never decided, aged from their FIRST
 * evaluation. RDP promotion candidates are deliberately NOT counted —
 * `rdp-distill` overwrites each candidate's `distilled_at` every pass (age always
 * resets to today) and nothing flips an RDP file out of `promotion_candidate` on
 * consumption (the lane never drains), so counting it would report a permanent,
 * un-aging `<7d` inflation. Adding RDP is gated on it first earning a truthful
 * age + consumption model.
 *
 * The input is a minimal structural shape so a caller can feed the canonical
 * `readHarnessCandidateLifecycleRecords` output directly, without this module
 * importing that producer.
 */
import { HARNESS_CANDIDATE_LIFECYCLE_ACTIONS } from "@brewva/brewva-vocabulary/harness";

/** A harness candidate-ledger record projection (evaluated / accepted / rejected / archived). */
export interface ProposalLedgerRecord {
  readonly action: string;
  readonly candidateId: string;
  /** ISO timestamp. */
  readonly at: string;
}

export interface UnconsumedProposal {
  readonly id: string;
  /** ISO timestamp used for age bucketing — the FIRST evaluation (backlog start). */
  readonly at: string;
}

const EVALUATED_ACTION = "evaluated";
// The consumption actions, DERIVED from the vocabulary's lifecycle action set
// (minus "evaluated") rather than re-hardcoded — so a decision action added there
// later cannot silently leave a consumed candidate counted as backlog forever.
const DECISION_ACTIONS = new Set<string>(
  HARNESS_CANDIDATE_LIFECYCLE_ACTIONS.filter((action) => action !== EVALUATED_ACTION),
);

/**
 * A harness candidate is UNCONSUMED when it has at least one `evaluated` receipt
 * and zero decision receipts. Its age reference is the EARLIEST evaluation — how
 * long it has sat undecided — not the latest, which a re-evaluation would reset.
 */
export function unconsumedHarnessCandidates(
  records: readonly ProposalLedgerRecord[],
): UnconsumedProposal[] {
  const firstEvaluatedAt = new Map<string, string>();
  const decided = new Set<string>();
  for (const record of records) {
    if (record.action === EVALUATED_ACTION) {
      const previous = firstEvaluatedAt.get(record.candidateId);
      if (previous === undefined || record.at < previous) {
        firstEvaluatedAt.set(record.candidateId, record.at);
      }
    } else if (DECISION_ACTIONS.has(record.action)) {
      decided.add(record.candidateId);
    }
  }
  const proposals: UnconsumedProposal[] = [];
  for (const [candidateId, at] of firstEvaluatedAt) {
    if (!decided.has(candidateId)) {
      proposals.push({ id: candidateId, at });
    }
  }
  return proposals;
}

const PROPOSAL_AGE_BUCKETS = [
  { label: "<7d", maxDays: 7 },
  { label: "7-30d", maxDays: 30 },
  { label: ">30d", maxDays: Number.POSITIVE_INFINITY },
] as const;

export interface ProposalBacklogBucket {
  readonly label: string;
  readonly count: number;
}

export interface ProposalBacklog {
  readonly total: number;
  readonly byAge: readonly ProposalBacklogBucket[];
}

function ageInDays(at: string, nowMs: number): number {
  const parsed = Date.parse(at);
  // An unparseable/absent stamp is surfaced in the oldest bucket rather than
  // dropped — a proposal with no age is exactly the kind of backlog to see.
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - parsed) / (1000 * 60 * 60 * 24));
}

export function countProposalBacklog(input: {
  readonly proposals: readonly UnconsumedProposal[];
  readonly nowMs: number;
}): ProposalBacklog {
  const byAge = PROPOSAL_AGE_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  for (const proposal of input.proposals) {
    const days = ageInDays(proposal.at, input.nowMs);
    const index = PROPOSAL_AGE_BUCKETS.findIndex((bucket) => days < bucket.maxDays);
    const target = byAge[index === -1 ? byAge.length - 1 : index];
    if (target) target.count += 1;
  }
  return { total: input.proposals.length, byAge };
}
