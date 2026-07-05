import type {
  DelegationModelRouteRecord,
  DelegationReviewDispatch,
} from "@brewva/brewva-vocabulary/delegation";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type {
  IndependenceBasis,
  ReviewerContext,
  ReviewFindingCategory,
  ReviewFindingSeverity,
} from "@brewva/brewva-vocabulary/review";
import {
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_SEVERITIES,
} from "@brewva/brewva-vocabulary/review";
import type { DelegationOutcomeFinding, ReviewLaneDisposition } from "../../contracts/index.js";
import {
  recordReviewFinding,
  recordVerificationOutcome,
  type VerificationRecordingRuntime,
} from "../../runtime-port/verification.js";
import {
  coerceStoredReviewOutcomeData,
  deriveReviewDisposition,
} from "../../shared/review-ensemble/index.js";

/** Verification-ladder rung an independent review earns: it re-derives requirements from code. */
export const REVIEW_OUTCOME_LEVEL = "requirements" as const;

export interface ReviewOutcomeMapping {
  readonly outcome: "pass" | "fail" | "skipped";
  readonly reason: string | null;
}

/** clear -> pass; concern|blocked -> fail; inconclusive -> skipped (with a reason). */
export function mapDispositionToOutcome(
  disposition: ReviewLaneDisposition,
  conclusion: string | undefined,
): ReviewOutcomeMapping {
  switch (disposition) {
    case "clear":
      return { outcome: "pass", reason: null };
    case "inconclusive":
      return {
        outcome: "skipped",
        reason:
          conclusion && conclusion.trim().length > 0
            ? conclusion.trim()
            : "review was inconclusive: evidence was insufficient to reach a verdict.",
      };
    default:
      return { outcome: "fail", reason: null };
  }
}

/**
 * Compose the independence bases honestly. fresh_context is always present (a
 * bounded reviewer with a withheld author context). preloaded_lens is added
 * when the caller supplied lenses. different_model is deliberately NOT added:
 * neither committer can see the calling session's own model, so comparing it
 * against the routed model would be a guess — omitted per the loop's honesty
 * rule.
 */
export function composeIndependenceBasis(lenses: readonly string[]): IndependenceBasis[] {
  const basis: IndependenceBasis[] = ["fresh_context"];
  if (lenses.length > 0) {
    basis.push("preloaded_lens");
  }
  return basis;
}

/**
 * Resolve the routed model string from a delegation run's `modelRoute`
 * record, honestly: `selectedModel` is the routing decision's field name,
 * `model` is an older/alternate field some route shapes carry — prefer
 * `selectedModel`, fall back to `model`, and reject anything that is not a
 * non-empty string. Shared by both callers that read a run's routed model —
 * `review_request`'s completion path (`readRoutedModel`, via `listRuns`) and
 * the gateway's finalization observer (reading the already-in-hand run
 * record) — so the selection rule can not drift between the two.
 */
export function resolveRoutedModel(
  modelRoute: DelegationModelRouteRecord | undefined,
): string | null {
  const model = modelRoute?.selectedModel ?? modelRoute?.model;
  return typeof model === "string" && model.length > 0 ? model : null;
}

const SEVERITY_ORDER = REVIEW_FINDING_SEVERITIES;

export function normalizeReviewFindingSeverity(
  value: DelegationOutcomeFinding["severity"],
): ReviewFindingSeverity {
  return value && (SEVERITY_ORDER as readonly string[]).includes(value) ? value : "low";
}

/**
 * Deterministic, distinct finding id derived from the run id and the finding's
 * ordinal, so the same review produces the same ids across replays.
 */
export function deriveReviewFindingId(runId: string, index: number): string {
  return `${runId}-finding-${index + 1}`;
}

/**
 * Map the reviewer-declared category (the open-adversarial stance asks for
 * one of `REVIEW_FINDING_CATEGORIES`) into the receipt. Defaults to
 * `"unknown"` when the reviewer omitted it or reported something outside the
 * vocabulary (Finding P3) — never drop the finding, never trust an unvalidated
 * string onto the receipt, and never DISGUISE an unknown category as
 * `"correctness"` (the prior default), which mislabeled
 * architecture/concurrency/etc. findings and polluted category analytics.
 */
function categoryForFinding(finding: DelegationOutcomeFinding): ReviewFindingCategory {
  return finding.category &&
    (REVIEW_FINDING_CATEGORIES as readonly string[]).includes(finding.category)
    ? finding.category
    : "unknown";
}

/**
 * The lens/stance names the outcome receipt says it examined. The base name is
 * honest about which stance actually ran: `open_adversarial_stance` only when
 * the default framing was used, `custom_stance` when the caller replaced it
 * wholesale — the receipt must never claim a stance the reviewer did not run.
 */
function reviewCheckNames(dispatch: DelegationReviewDispatch): string[] {
  const stanceCheck = dispatch.stanceOverridden ? "custom_stance" : "open_adversarial_stance";
  return [stanceCheck, ...dispatch.lenses];
}

/**
 * What the committer observed about the finished run:
 * - `reviewer_outcome`: the run completed and delivered a reviewer outcome
 *   (its structured `data` may still be missing or garbage — the ok gate and
 *   the coercion decide what it is worth).
 * - `run_terminal_failure`: the run errored or was cancelled before delivering
 *   a verdict. Axiom 7: the honest receipt is an independent `skipped` outcome
 *   carrying the failure reason — never fabricated findings.
 */
export type ReviewReceiptSource =
  | {
      readonly kind: "reviewer_outcome";
      readonly ok: boolean;
      readonly data: unknown;
    }
  | { readonly kind: "run_terminal_failure"; readonly reason: string };

export interface CommitReviewReceiptsInput {
  readonly runtime: VerificationRecordingRuntime;
  readonly sessionId: string;
  readonly runId: string;
  /** The routed model read from the run record; never guessed. */
  readonly routedModel: string | null;
  /** The dispatch-time anchor: pre-dispatch snapshot + lens/stance metadata. */
  readonly dispatch: DelegationReviewDispatch;
  readonly source: ReviewReceiptSource;
}

/**
 * Why a commit did not happen (Finding P3): the independent-outcome write seam
 * was unavailable (`outcome_unavailable`), or there WERE findings to record but
 * the finding-record capability was absent (`findings_unavailable`) — committing
 * the outcome while silently dropping those findings is the dishonesty this
 * removes, so the commit fails closed BEFORE writing a misleading receipt.
 */
export type CommitReviewFailureReason = "outcome_unavailable" | "findings_unavailable";

export type CommitReviewReceiptsResult =
  | { readonly committed: false; readonly reason: CommitReviewFailureReason }
  | {
      readonly committed: true;
      /** True when the tape already held this run's independent outcome (idempotent skip). */
      readonly alreadyCommitted: boolean;
      readonly outcome: "pass" | "fail" | "skipped";
      readonly disposition: ReviewLaneDisposition;
      readonly findings: readonly DelegationOutcomeFinding[];
      /**
       * The TRUE number of `review.finding.recorded` receipts that actually
       * landed (Finding P3) — non-`undefined` returns from the record seam, NOT
       * `findings.length` by assumption. On the idempotent-skip path the findings
       * were committed by the first commit, so this reports `findings.length`.
       */
      readonly recordedFindingCount: number;
    };

/**
 * Tape-derived exactly-once guard: has an independent outcome for this run
 * already been committed? Keyed on `reviewerContext.contextId === runId`, read
 * back from the tape itself — never an in-memory flag — so observer re-entry,
 * a duplicated terminal transition, or a tool/observer double-commit all
 * collapse to one receipt set.
 */
function hasIndependentOutcomeForRun(
  runtime: VerificationRecordingRuntime,
  sessionId: string,
  runId: string,
): boolean {
  const records = runtime.capabilities.events?.records;
  // Deliberate fail-open: when `records.query` is absent, treat the tape as
  // holding no prior receipt rather than refusing to commit. Every real
  // runtime supplies `query`; this is a best-effort idempotency guard for a
  // theoretical capability-less runtime, not a correctness-critical path.
  // Uses `.query` (not `.list`): the hosted runtime's two methods are the
  // same underlying read, and `review_request`'s single declared read
  // capability (Task 9: shared with the session-touched-files/trap-lens
  // preload reads on the same call graph) is `capabilities.events.records.
  // query` — this call must use the identical name so the managed-tool
  // capability gate does not reject it.
  const events = records?.query
    ? records.query(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      })
    : [];
  return events.some((event) => {
    const payload = readVerificationOutcomeRecordedEventPayload(event);
    return payload.perspective === "independent" && payload.reviewerContext?.contextId === runId;
  });
}

/**
 * THE single receipt-commit path for an independent review run. Both callers —
 * review_request's completion mode (in-tool, after the reviewer returns) and
 * the gateway's delegation-finalization observer (start mode, when a tagged
 * run reaches terminal status) — commit through this one function, so the
 * disposition mapping, ordering, honesty labels, and idempotency can never
 * drift between modes.
 *
 * Ordering: the independent `verification.outcome.recorded` receipt commits
 * FIRST, then one `review.finding.recorded` per parsed finding. If the outcome
 * write seam is unavailable it bails having written nothing — the tape can never
 * hold findings without their governing independent outcome.
 *
 * Honesty (Finding P3): when there ARE findings to record, the finding-record
 * capability is PREFLIGHTED before the outcome is committed. If it is absent,
 * the commit fails closed (`findings_unavailable`) rather than committing a
 * misleading "independent review happened" outcome with the findings silently
 * dropped. On the happy path each finding is recorded and the non-`undefined`
 * returns are COUNTED, so the returned `recordedFindingCount` reflects what
 * actually landed even if an individual write unexpectedly returns undefined.
 */
export function commitReviewReceipts(input: CommitReviewReceiptsInput): CommitReviewReceiptsResult {
  const reviewData =
    input.source.kind === "reviewer_outcome" && input.source.ok
      ? coerceStoredReviewOutcomeData(input.source.data)
      : undefined;
  const disposition: ReviewLaneDisposition =
    input.source.kind === "run_terminal_failure"
      ? "inconclusive"
      : deriveReviewDisposition(reviewData);
  const findings: readonly DelegationOutcomeFinding[] = reviewData?.findings ?? [];
  const { outcome, reason } =
    input.source.kind === "run_terminal_failure"
      ? mapDispositionToOutcome("inconclusive", input.source.reason)
      : mapDispositionToOutcome(disposition, reviewData?.conclusion);

  if (hasIndependentOutcomeForRun(input.runtime, input.sessionId, input.runId)) {
    // Idempotent skip: the first commit already landed the outcome AND its
    // findings, so the recorded count is the parsed finding count.
    return {
      committed: true,
      alreadyCommitted: true,
      outcome,
      disposition,
      findings,
      recordedFindingCount: findings.length,
    };
  }

  // Preflight (Finding P3): if there are findings to record but the capability
  // is absent, do NOT commit a misleading independent outcome whose findings
  // would be silently dropped. Probe capability PRESENCE, not by writing — the
  // write itself is the side effect we must not perform before the outcome. The
  // `in` check inspects the property WITHOUT referencing the method (avoiding an
  // unbound-method reference). A clear review with no findings is unaffected and
  // commits below.
  const findingsCapability = input.runtime.capabilities.verification?.findings;
  const canRecordFindings = findingsCapability !== undefined && "record" in findingsCapability;
  if (findings.length > 0 && !canRecordFindings) {
    return { committed: false, reason: "findings_unavailable" };
  }

  const reviewerContext: ReviewerContext = {
    model: input.routedModel,
    contextId: input.runId,
    lenses: [...input.dispatch.lenses],
  };
  // CLEAR-ONLY positive signal (the fitness loop's affirmative half). The
  // outcome's atomRefs names the reviewed atoms ONLY when the disposition maps
  // to `pass` (clear) AND the dispatch targeted atoms. NEVER on a fail: the
  // projection treats an independent-fail outcome as violating ALL its atomRefs
  // (fitness.ts), so a blanket list on a concern/blocked review would wrongly
  // violate target atoms that have no specific finding — findings own
  // violations; this list is exclusively "affirmatively verified". A
  // files/session_diff clear review has no reviewedAtomIds, so it stays [].
  const outcomeAtomRefs = outcome === "pass" ? [...(input.dispatch.reviewedAtomIds ?? [])] : [];
  const committed = recordVerificationOutcome(input.runtime, input.sessionId, {
    outcome,
    level: REVIEW_OUTCOME_LEVEL,
    checks: reviewCheckNames(input.dispatch),
    failedChecks: [],
    missingChecks: [],
    missingEvidence: reviewData?.missingEvidence ? [...reviewData.missingEvidence] : [],
    evidenceFreshness: "fresh",
    reason,
    perspective: "independent",
    independenceBasis: composeIndependenceBasis(input.dispatch.lenses),
    reviewerContext,
    targetRef: input.dispatch.targetRef,
    // An independent review receipt carries no claim-time fitness annotation:
    // the fitness cross-check is a property of the AUTHORED pass being made in
    // verification_record, not of an independent reviewer's finding-bearing
    // outcome. Both fields stay empty here.
    discrepancies: [],
    unverifiedMustAtoms: [],
    // Clear-only: the atoms this outcome affirmatively verifies (see above).
    atomRefs: outcomeAtomRefs,
  });
  if (!committed) {
    return { committed: false, reason: "outcome_unavailable" };
  }

  // lens is null on each finding: no per-lens attribution in this
  // single-reviewer flow (the open stance reviews as one context). Count the
  // non-`undefined` returns so the reported count is what ACTUALLY landed
  // (Finding P3): the preflight above guarantees the capability is present, but
  // an individual write can still return undefined (e.g. a targetRef that will
  // not parse), and the count must reflect that reality.
  let recordedFindingCount = 0;
  for (const [index, finding] of findings.entries()) {
    const recorded = recordReviewFinding(input.runtime, input.sessionId, {
      findingId: deriveReviewFindingId(input.runId, index),
      severity: normalizeReviewFindingSeverity(finding.severity),
      category: categoryForFinding(finding),
      statement: finding.summary,
      anchors: finding.evidenceRefs ? [...finding.evidenceRefs] : [],
      lens: null,
      targetRef: input.dispatch.targetRef,
      // Reviewer-reported atom ids (Task 14), parsed through the same
      // structured-deliverable path every finding field uses
      // (`coerceStoredReviewOutcomeData` -> `readStoredFinding`). Absent for
      // most findings (non-atoms targets, or a reviewer that named no atom) —
      // never invented, honestly `[]`.
      atomRefs: finding.atomRefs ? [...finding.atomRefs] : [],
    });
    if (recorded !== undefined) {
      recordedFindingCount += 1;
    }
  }

  return {
    committed: true,
    alreadyCommitted: false,
    outcome,
    disposition,
    findings,
    recordedFindingCount,
  };
}
