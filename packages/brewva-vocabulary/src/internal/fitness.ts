import { reviewTargetRefMatchesTapeOnly } from "./review.js";
import type { ReviewFindingRecordedEventPayload } from "./review.js";
import type { RequirementAtom } from "./task.js";

/**
 * How well one requirement atom is met, given the evidence joined against it.
 *
 * - `satisfied`: deterministic OR independent evidence that NAMES the atom
 *   asserts a pass; the strongest positive state.
 * - `likelySatisfied`: only author-claimed coverage supports it — believable
 *   but self-attested, so it never reaches `satisfied` on its own.
 * - `violated`: a live (non-stale) fail exists — a deterministic fail entry or
 *   a review finding on the atom; always accompanied by a graded discrepancy.
 * - `unverified`: no live evidence bears on the atom (or the only evidence was
 *   stale and dropped).
 * - `notApplicable`: an atom explicitly marked as not applicable. The current
 *   {@link RequirementAtom} shape carries NO such marker, so this state is
 *   UNREACHABLE from this join today — it is kept in the vocabulary for a later
 *   surface that may supply the marker, and this projection never produces it.
 */
export const ATOM_FITNESS_STATES = [
  "satisfied",
  "likelySatisfied",
  "violated",
  "unverified",
  "notApplicable",
] as const;

export type AtomFitnessState = (typeof ATOM_FITNESS_STATES)[number];

/**
 * One piece of evidence that contributed to an atom's fitness state. `kind`
 * names where it came from; `ref` is the evidence's stable id (finding id,
 * outcome ref, or deterministic entry ref); `verdict` is present for the kinds
 * that carry pass/fail (`authored` coverage carries no verdict — it only
 * claims the atom was addressed, not that a check passed).
 *
 * This is intentionally the minimum the states and discrepancies need: the
 * projection has no authority (axiom 18), so it records only enough for a
 * reader to see WHAT decided the state, not to re-adjudicate it.
 */
export interface AtomFitnessEvidence {
  readonly kind: "finding" | "independent_outcome" | "deterministic" | "authored";
  readonly ref: string;
  readonly verdict?: "pass" | "fail";
}

export interface AtomFitness {
  readonly atomId: string;
  readonly state: AtomFitnessState;
  /** What decided the state, sorted deterministically by (kind, ref, verdict). */
  readonly evidence: readonly AtomFitnessEvidence[];
}

/**
 * The two discrepancy grades a violated atom can carry, in the vocabulary's
 * own words (RFC-verbatim): `deterministic_conflict` when a deterministic
 * evidence entry (scripted check, gate) drove the violation, `advisory_conflict`
 * when only an LLM review finding did. SINGLE-HOMED here — every site that
 * checks or enumerates a grade (the receipt reader's `isFitnessDiscrepancy`,
 * `verification_record`'s claim-time summary, `inspect run-report`'s
 * discrepancies-by-grade tally) imports this instead of holding its own
 * literal union, so a future third grade is added in exactly one place and
 * every `Record<FitnessDiscrepancyGrade, ...>` built by iterating this tuple
 * becomes total by construction.
 */
export const FITNESS_DISCREPANCY_GRADES = ["deterministic_conflict", "advisory_conflict"] as const;

export type FitnessDiscrepancyGrade = (typeof FITNESS_DISCREPANCY_GRADES)[number];

/**
 * A surfaced conflict for a `violated` atom. `grade` records whether a
 * deterministic entry drove the violation (`deterministic_conflict`) or only an
 * LLM review finding did (`advisory_conflict`) — only deterministic evidence
 * can produce `deterministic_conflict`. `evidenceRef` points at the specific
 * fail evidence (deterministic entry ref or finding id) so a reader can trace
 * the claim.
 */
export interface FitnessDiscrepancy {
  readonly atomId: string;
  readonly grade: FitnessDiscrepancyGrade;
  readonly statement: string;
  readonly evidenceRef: string;
}

export interface FitnessProjection {
  readonly atoms: readonly AtomFitness[];
  readonly counts: Readonly<Record<AtomFitnessState, number>>;
  readonly discrepancies: readonly FitnessDiscrepancy[];
  readonly unverifiedMustAtoms: readonly string[];
}

/**
 * A review finding paired with its OWN receipt timestamp. The finding payload
 * ({@link ReviewFindingRecordedEventPayload}) carries `targetRef` and `atomRefs`
 * but no timestamp, so the caller supplies `receiptTimestamp` from the tape
 * event that recorded the finding. Staleness is judged per-finding against this
 * timestamp (mirroring the per-receipt-timestamp discipline of
 * `projectTapeReviewDebt`), never against a shared "latest" timestamp.
 */
export interface FitnessReviewFinding {
  readonly finding: ReviewFindingRecordedEventPayload;
  readonly receiptTimestamp: number;
}

/**
 * An independent-perspective outcome receipt that NAMES the atoms it bears on.
 * A `pass` here is strong positive evidence (can reach `satisfied`); a `fail`
 * is treated as a violation, same as a deterministic fail's downgrade but
 * graded `advisory_conflict` (it is not deterministic evidence).
 */
export interface FitnessIndependentOutcome {
  readonly atomRefs: readonly string[];
  readonly verdict: "pass" | "fail";
  readonly ref: string;
}

/**
 * An author-claimed outcome: the same reasoning stream that authored the change
 * asserts it covers these atoms. Author coverage alone yields at most
 * `likelySatisfied` — it never proves satisfaction and never violates.
 */
export interface FitnessAuthoredOutcome {
  readonly atomRefs: readonly string[];
  readonly ref: string;
}

/**
 * A deterministic evidence entry keyed to one atom. The caller maps
 * verification-gate and scripted-check evidence into this shape; the projection
 * only knows it is `deterministic` (a fail here grades `deterministic_conflict`).
 */
export interface DeterministicFitnessEvidence {
  readonly atomId: string;
  readonly verdict: "pass" | "fail";
  readonly ref: string;
}

/**
 * The pure input to {@link projectRequirementFitness}. Every field is assembled
 * by the effectful caller from tape receipts; the projection itself does no I/O
 * and reads no clock. `appliedPatchSetRefs` + `latestTreeMutationAt` feed the
 * SAME conservative tape-only staleness matcher (`reviewTargetRefMatchesTapeOnly`)
 * that the review-debt surfaces use — one staleness rule across debt and fitness.
 */
export interface RequirementFitnessInput {
  readonly atoms: readonly RequirementAtom[];
  readonly findings: readonly FitnessReviewFinding[];
  readonly independentOutcomes: readonly FitnessIndependentOutcome[];
  readonly authoredOutcomes: readonly FitnessAuthoredOutcome[];
  readonly deterministicEvidence: readonly DeterministicFitnessEvidence[];
  /** Currently applied patch-set ids, tape-derived — matcher input for `patch_sets` refs. */
  readonly appliedPatchSetRefs: readonly string[];
  /**
   * Latest tape tree-mutation timestamp — a successful patch application,
   * rollback, OR bare write/edit invocation (Finding P1), or null if none —
   * matcher input for `file_digests` staleness. Derived via the shared
   * `deriveLatestTreeMutationAt` fold. See `reviewTargetRefMatchesTapeOnly`.
   */
  readonly latestTreeMutationAt: number | null;
}

/** Ranks an evidence entry for deterministic, order-independent sorting within an atom. */
const EVIDENCE_KIND_ORDER: Readonly<Record<AtomFitnessEvidence["kind"], number>> = {
  deterministic: 0,
  independent_outcome: 1,
  finding: 2,
  authored: 3,
};

function compareEvidence(left: AtomFitnessEvidence, right: AtomFitnessEvidence): number {
  const kindDelta = EVIDENCE_KIND_ORDER[left.kind] - EVIDENCE_KIND_ORDER[right.kind];
  if (kindDelta !== 0) {
    return kindDelta;
  }
  if (left.ref !== right.ref) {
    return left.ref < right.ref ? -1 : 1;
  }
  // Two entries can share (kind, ref) yet differ in verdict (e.g. one outcome
  // ref reused for a pass and a fail on the same atom). Break the tie on verdict
  // so the sort is TOTAL and thus order-independent — otherwise the pre-sort
  // input order would leak into the result.
  const leftVerdict = left.verdict ?? "";
  const rightVerdict = right.verdict ?? "";
  return leftVerdict < rightVerdict ? -1 : leftVerdict > rightVerdict ? 1 : 0;
}

/** Mutable accumulator for one atom while the join folds evidence into it. */
interface AtomAccumulator {
  readonly atom: RequirementAtom;
  readonly evidence: AtomFitnessEvidence[];
  hasDeterministicPass: boolean;
  hasIndependentPass: boolean;
  hasAuthored: boolean;
  /** A live deterministic fail, if any — drives `deterministic_conflict`. */
  deterministicFailRef: string | null;
  /** A live finding on this atom, if any — drives `advisory_conflict`. */
  findingFailRef: string | null;
}

/**
 * The pure requirement-fitness projection: join folded requirement atoms
 * against the evidence that bears on them and derive a per-atom fitness state,
 * a per-state tally, graded discrepancies for violations, and the ids of unmet
 * `must` atoms.
 *
 * This is a VIEW with no authority (axiom 18): nothing gates on it and it is
 * rebuildable from receipts alone (axiom 6). It reads no filesystem and no
 * clock, and is order-independent in every evidence array — the same inputs
 * yield a byte-identical projection regardless of receipt order.
 *
 * Join rules (RFC-verbatim):
 * - STALENESS NEVER VIOLATES. A finding whose `targetRef` no longer matches the
 *   current tree (judged by `reviewTargetRefMatchesTapeOnly` against the
 *   finding's OWN `receiptTimestamp`) is dropped entirely: it contributes
 *   nothing to `violated` and no discrepancy. Independent/deterministic
 *   outcomes are keyed to atoms, not to a tree snapshot, so they are not
 *   staleness-checked here (the caller decides which to feed in).
 * - A live fail DOMINATES a coexisting pass. If an atom has both satisfying and
 *   violating evidence, the atom is `violated` and the conflict surfaces — a
 *   pass never masks a real fail.
 * - GRADING: a deterministic fail grades `deterministic_conflict`; a review
 *   finding grades `advisory_conflict`. When both a deterministic fail and a
 *   finding exist, the deterministic grade is preferred (only deterministic
 *   evidence can produce `deterministic_conflict`); each violated atom yields
 *   exactly ONE discrepancy.
 * - `satisfied` requires a deterministic pass keyed to the atom OR an
 *   independent outcome that names it. Author coverage alone caps at
 *   `likelySatisfied`.
 * - No live evidence -> `unverified`.
 * - `notApplicable` is never produced (see {@link ATOM_FITNESS_STATES}).
 * - `unverifiedMustAtoms` = ids of `must`-modality atoms whose state is
 *   `unverified`, in first-appearance order.
 * - `counts` = per-state tally over ALL atoms.
 */
export function projectRequirementFitness(input: RequirementFitnessInput): FitnessProjection {
  const accumulators = new Map<string, AtomAccumulator>();
  const order: string[] = [];
  for (const atom of input.atoms) {
    if (accumulators.has(atom.id)) {
      continue;
    }
    accumulators.set(atom.id, {
      atom,
      evidence: [],
      hasDeterministicPass: false,
      hasIndependentPass: false,
      hasAuthored: false,
      deterministicFailRef: null,
      findingFailRef: null,
    });
    order.push(atom.id);
  }

  for (const entry of input.deterministicEvidence) {
    const accumulator = accumulators.get(entry.atomId);
    if (!accumulator) {
      continue;
    }
    accumulator.evidence.push({ kind: "deterministic", ref: entry.ref, verdict: entry.verdict });
    if (entry.verdict === "pass") {
      accumulator.hasDeterministicPass = true;
    } else if (
      accumulator.deterministicFailRef === null ||
      entry.ref < accumulator.deterministicFailRef
    ) {
      // Lowest ref wins so the chosen discrepancy is order-independent.
      accumulator.deterministicFailRef = entry.ref;
    }
  }

  for (const outcome of input.independentOutcomes) {
    for (const atomId of outcome.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      accumulator.evidence.push({
        kind: "independent_outcome",
        ref: outcome.ref,
        verdict: outcome.verdict,
      });
      if (outcome.verdict === "pass") {
        accumulator.hasIndependentPass = true;
      } else if (accumulator.findingFailRef === null || outcome.ref < accumulator.findingFailRef) {
        // An independent fail is a non-deterministic violation -> advisory grade,
        // sharing the finding-fail channel (lowest ref wins for determinism).
        accumulator.findingFailRef = outcome.ref;
      }
    }
  }

  for (const authored of input.authoredOutcomes) {
    for (const atomId of authored.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      accumulator.evidence.push({ kind: "authored", ref: authored.ref });
      accumulator.hasAuthored = true;
    }
  }

  for (const { finding, receiptTimestamp } of input.findings) {
    const fresh = reviewTargetRefMatchesTapeOnly(finding.targetRef, {
      appliedPatchSetRefs: input.appliedPatchSetRefs,
      receiptTimestamp,
      latestTreeMutationAt: input.latestTreeMutationAt,
    });
    if (!fresh) {
      // STALENESS NEVER VIOLATES: a stale finding is dropped whole — no evidence
      // entry, no violation, no discrepancy. The atom stays unverified unless
      // OTHER live evidence decides it.
      continue;
    }
    for (const atomId of finding.atomRefs) {
      const accumulator = accumulators.get(atomId);
      if (!accumulator) {
        continue;
      }
      accumulator.evidence.push({ kind: "finding", ref: finding.findingId });
      if (accumulator.findingFailRef === null || finding.findingId < accumulator.findingFailRef) {
        accumulator.findingFailRef = finding.findingId;
      }
    }
  }

  const atoms: AtomFitness[] = [];
  const counts: Record<AtomFitnessState, number> = {
    satisfied: 0,
    likelySatisfied: 0,
    violated: 0,
    unverified: 0,
    notApplicable: 0,
  };
  const discrepancies: FitnessDiscrepancy[] = [];

  for (const atomId of order) {
    const accumulator = accumulators.get(atomId);
    if (!accumulator) {
      continue;
    }
    const state = resolveState(accumulator);
    counts[state] += 1;
    atoms.push({
      atomId,
      state,
      evidence: accumulator.evidence.toSorted(compareEvidence),
    });
    if (state === "violated") {
      discrepancies.push(buildDiscrepancy(accumulator));
    }
  }

  const sortedDiscrepancies = discrepancies.toSorted((left, right) => {
    if (left.atomId !== right.atomId) {
      return left.atomId < right.atomId ? -1 : 1;
    }
    return left.evidenceRef < right.evidenceRef ? -1 : left.evidenceRef > right.evidenceRef ? 1 : 0;
  });

  const unverifiedMustAtoms = atoms
    .filter(
      (entry) =>
        entry.state === "unverified" && accumulators.get(entry.atomId)?.atom.modality === "must",
    )
    .map((entry) => entry.atomId);

  return { atoms, counts, discrepancies: sortedDiscrepancies, unverifiedMustAtoms };
}

/**
 * Precedence: a live fail (deterministic OR finding/independent) wins over any
 * pass; then a keyed/independent pass reaches `satisfied`; then author coverage
 * alone reaches `likelySatisfied`; else `unverified`. `notApplicable` is never
 * reached — no marker exists on the atom to select it.
 */
function resolveState(accumulator: AtomAccumulator): AtomFitnessState {
  if (accumulator.deterministicFailRef !== null || accumulator.findingFailRef !== null) {
    return "violated";
  }
  if (accumulator.hasDeterministicPass || accumulator.hasIndependentPass) {
    return "satisfied";
  }
  if (accumulator.hasAuthored) {
    return "likelySatisfied";
  }
  return "unverified";
}

/**
 * Build the single discrepancy for a violated atom. A deterministic fail is
 * preferred (only it grades `deterministic_conflict`); otherwise the finding
 * (or independent-fail) grades `advisory_conflict`.
 */
function buildDiscrepancy(accumulator: AtomAccumulator): FitnessDiscrepancy {
  if (accumulator.deterministicFailRef !== null) {
    return {
      atomId: accumulator.atom.id,
      grade: "deterministic_conflict",
      statement: accumulator.atom.statement,
      evidenceRef: accumulator.deterministicFailRef,
    };
  }
  if (accumulator.findingFailRef === null) {
    // Unreachable by construction: buildDiscrepancy is only called for a
    // `violated` atom, and resolveState returns `violated` only when a
    // deterministic OR a finding fail ref is set. The deterministic branch is
    // taken above, so reaching here with a null finding ref means that invariant
    // was broken by a future refactor. Fail LOUDLY rather than emit an empty
    // evidenceRef that would silently untraceably corrupt the discrepancy.
    throw new Error(
      `fitness invariant violated: advisory discrepancy for atom ${accumulator.atom.id} has no finding fail ref`,
    );
  }
  return {
    atomId: accumulator.atom.id,
    grade: "advisory_conflict",
    statement: accumulator.atom.statement,
    evidenceRef: accumulator.findingFailRef,
  };
}

/**
 * The reason a requirement-verification debt carries, or null when there is no
 * debt.
 *
 * - `ladder_below_requirements`: fresh code was written and >= 1 `must` atom is
 *   `unverified`, and NO verification pass ever reached the `requirements` rung
 *   — the ladder stopped lower (e.g. `artifact`: does it build/sign?) without
 *   grading the atoms against evidence. This is the "green-but-unverified"
 *   termination shape: a build-level pass looks done while the requirements were
 *   never actually checked.
 * - `unverified_after_requirements`: a pass DID reach `requirements`, yet >= 1
 *   `must` atom is STILL `unverified` — a coverage gap, not a skipped rung.
 */
export type UnverifiedRequirementDebtReason =
  | "ladder_below_requirements"
  | "unverified_after_requirements";

/** Descriptive requirement-verification debt (advisory, never a gate — axiom 18). */
export interface UnverifiedRequirementDebt {
  readonly debt: boolean;
  /** Count of `must`-modality atoms whose fitness state is `unverified`. */
  readonly unverifiedMustCount: number;
  readonly reason: UnverifiedRequirementDebtReason | null;
}

/** Inputs {@link projectUnverifiedRequirementDebt} needs — all tape-derived, no I/O. */
export interface UnverifiedRequirementDebtInput {
  /** A tool actually wrote/edited code this session (the debt is meaningless with no fresh code). */
  readonly freshCodeWritten: boolean;
  /** `projectRequirementFitness(...).unverifiedMustAtoms.length`. */
  readonly unverifiedMustCount: number;
  /** Did ANY verification pass reach the `requirements` rung or above? */
  readonly reachedRequirementsVerify: boolean;
}

/**
 * Pure projection, sibling to `projectReviewDebt`: does the current tape state
 * carry requirement-verification debt — fresh code written AND at least one
 * `must`-modality atom still `unverified`? This is the "green below the
 * requirements rung" pressure the review-debt marker cannot express: review debt
 * fires only AFTER a `requirements`+ pass (it asks "was that pass independently
 * reviewed?"), so a session that terminates on an `artifact`-level green —
 * never climbing to a requirements verify — leaves review debt at `false` while
 * its `must` requirements were never graded. This projection names that gap.
 * Advisory only: it changes no receipt and gates nothing (axiom 18).
 */
export function projectUnverifiedRequirementDebt(
  input: UnverifiedRequirementDebtInput,
): UnverifiedRequirementDebt {
  if (!input.freshCodeWritten || input.unverifiedMustCount <= 0) {
    return { debt: false, unverifiedMustCount: input.unverifiedMustCount, reason: null };
  }
  return {
    debt: true,
    unverifiedMustCount: input.unverifiedMustCount,
    reason: input.reachedRequirementsVerify
      ? "unverified_after_requirements"
      : "ladder_below_requirements",
  };
}
