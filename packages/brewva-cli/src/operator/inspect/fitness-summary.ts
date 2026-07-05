import { FITNESS_DISCREPANCY_GRADES } from "@brewva/brewva-vocabulary/fitness";
import type {
  FitnessDiscrepancy,
  FitnessDiscrepancyGrade,
} from "@brewva/brewva-vocabulary/fitness";

/**
 * THE single receipt->fitness-summary read for every CLI surface that needs
 * it (`inspect run-report`'s Fitness section, the Work Card fitness line) —
 * both call this instead of independently tallying the same two receipt
 * fields, mirroring `review-debt.ts`'s "one fold, every surface imports it"
 * convention for tape-only review debt.
 *
 * ARCHITECTURAL RULING (W3 wave review, binding): this reads ONLY what a
 * `verification.outcome.recorded` receipt legitimately carries —
 * `discrepancies[]` and `unverifiedMustAtoms[]`, both committed once at claim
 * time by `verification_record` (Task 13's annotation, never re-run here). It
 * deliberately does NOT report `satisfied` / `likelySatisfied` / `notApplicable`
 * counts: those are re-derivable `projectRequirementFitness` outputs, not
 * receipt-committed facts (axiom 5/6 — a view is rebuildable from receipts,
 * but the receipt itself only ever recorded the violation/unverified-must
 * side of the join). Widening the receipt to carry the full 5-state tally
 * would thicken commitment memory with re-derivable projection output; the
 * fix for "I want the full breakdown" is to re-run the projection where that
 * is legitimate (`verification_record`'s own turn-scale summary), not to
 * store it here.
 */
export interface ReceiptFitnessSummary {
  /** One discrepancy per violated atom, by construction of `projectRequirementFitness`. */
  readonly violated: number;
  /** Count of unmet `must`-modality atoms the latest receipt named. */
  readonly unverifiedMust: number;
  /** Total map over every {@link FitnessDiscrepancyGrade} — 0 for a grade that never occurred, never absent. */
  readonly discrepanciesByGrade: Readonly<Record<FitnessDiscrepancyGrade, number>>;
}

/** The minimal receipt shape this reads — either a real receipt's fields or the empty defaults for no/ungated receipt. */
export interface ReceiptFitnessAnnotation {
  readonly discrepancies: readonly FitnessDiscrepancy[];
  readonly unverifiedMustAtoms: readonly string[];
}

/**
 * Pure tally over an already-parsed receipt annotation. No I/O, no clock, no
 * re-projection — callers supply the LATEST `verification.outcome.recorded`
 * receipt's own committed `discrepancies`/`unverifiedMustAtoms` (empty arrays
 * when no receipt exists, or the latest one carries no annotation because it
 * was below the `requirements` rung or not a `pass`).
 */
export function readReceiptFitnessSummary(
  annotation: ReceiptFitnessAnnotation,
): ReceiptFitnessSummary {
  // Built by ITERATING FITNESS_DISCREPANCY_GRADES (not a hand-written record
  // literal) so a future third grade becomes a total map by construction — see
  // the vocabulary tuple's own doc comment for why this matters everywhere a
  // by-grade record is initialized.
  const discrepanciesByGrade = Object.fromEntries(
    FITNESS_DISCREPANCY_GRADES.map((grade) => [grade, 0]),
  ) as Record<FitnessDiscrepancyGrade, number>;
  for (const entry of annotation.discrepancies) {
    discrepanciesByGrade[entry.grade] += 1;
  }
  return {
    violated: annotation.discrepancies.length,
    unverifiedMust: annotation.unverifiedMustAtoms.length,
    discrepanciesByGrade,
  };
}
