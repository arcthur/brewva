import { assembleRequirementFitnessInputFromEvents } from "@brewva/brewva-tools/runtime-port";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  projectRequirementFitness,
  type FitnessProjection,
} from "@brewva/brewva-vocabulary/fitness";

/**
 * THE single tape-derived requirement-fitness read for the CLI operator surfaces
 * (`inspect run-report`'s Fitness section, the Work Card fitness line) — mirrors
 * `buildTapeReviewDebt`'s "one fold, every surface imports it" convention, and
 * folds through the SAME `assembleRequirementFitnessInputFromEvents` the runtime
 * `verification_record` path uses (no second assembler).
 *
 * Re-derives the CURRENT fitness over the WHOLE tape rather than reading the
 * latest `verification.outcome.recorded` receipt's frozen claim-time annotation.
 * That matters for two reasons (axiom 6 — a view rebuilds from receipts, it is
 * not a snapshot frozen at one claim's instant):
 *   - A clear INDEPENDENT atoms-review commits its `satisfied` evidence AFTER the
 *     authored verify in the natural write→verify→review order; only re-deriving
 *     over the full tape surfaces it. The frozen authored annotation never sees
 *     the later review.
 *   - The latest receipt after a review is the INDEPENDENT one, which carries an
 *     EMPTY claim-time annotation by design — reading it wholesale mis-reads
 *     "nothing unverified" for ANY review, cleared or not. Re-deriving reports
 *     the true current state.
 */
export function buildTapeRequirementFitness(
  events: readonly BrewvaEventRecord[],
): FitnessProjection {
  return projectRequirementFitness(assembleRequirementFitnessInputFromEvents(events));
}
