import { FITNESS_DISCREPANCY_GRADES } from "@brewva/brewva-vocabulary/fitness";
import type {
  FitnessDiscrepancy,
  FitnessDiscrepancyGrade,
  FitnessProjection,
} from "@brewva/brewva-vocabulary/fitness";

/**
 * Pure by-grade tally over a fitness annotation (`discrepancies[]` +
 * unverified-must ids) — source-agnostic; the caller decides where the
 * annotation comes from. No I/O, no clock, no re-projection.
 *
 * ARCHITECTURAL NOTE (supersedes the earlier W3 "read the frozen receipt" ruling,
 * per the satisfied-timing fix): the receipt still deliberately commits ONLY the
 * negative side (`discrepancies[]`/`unverifiedMustAtoms[]`) — the full 5-state
 * tally is NOT stored in commitment memory (axiom 5/6: a receipt records the
 * violation/unverified-must side; the rest is re-derivable). What changed is
 * where the CLI operator surfaces get the annotation: run-report's Fitness
 * section and the Work Card line no longer feed this the LATEST receipt's frozen
 * claim-time fields — they RE-DERIVE the current fitness over the whole tape
 * (`buildTapeRequirementFitness`) and feed the derived annotation here. That
 * surfaces a clear independent atoms-review's `satisfied` (which lands AFTER the
 * authored verify in the natural write→verify→review order), and fixes the bug
 * where the latest receipt after ANY review is the independent one — whose
 * claim-time annotation is empty by design — so reading it wholesale falsely
 * reported "nothing unverified". Re-deriving is axiom 6 done right: rebuild the
 * view from receipts, not a snapshot frozen at one claim's instant. It stores
 * nothing new.
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

/** The negative tally PLUS the positive `satisfied` count — the full operator view. */
export interface RequirementFitnessSummary extends ReceiptFitnessSummary {
  /** Atoms an independent clear atoms-review affirmatively verified (the positive half). */
  readonly satisfied: number;
}

/**
 * Map a re-derived {@link FitnessProjection} (from `buildTapeRequirementFitness`)
 * to the operator display summary — the ONE place the projection's `counts` and
 * annotation become the surfaced tally, so run-report and the Work Card can never
 * fork it.
 */
export function summarizeRequirementFitness(
  projection: FitnessProjection,
): RequirementFitnessSummary {
  return {
    ...readReceiptFitnessSummary({
      discrepancies: projection.discrepancies,
      unverifiedMustAtoms: projection.unverifiedMustAtoms,
    }),
    satisfied: projection.counts.satisfied,
  };
}
