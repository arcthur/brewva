import { assembleRequirementFitnessInputFromEvents } from "@brewva/brewva-tools/runtime-port";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  projectRequirementFitness,
  projectUnverifiedRequirementDebt,
  type FitnessProjection,
  type UnverifiedRequirementDebt,
} from "@brewva/brewva-vocabulary/fitness";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_RUNGS,
  type VerificationRung,
} from "@brewva/brewva-vocabulary/iteration";
import {
  projectFreshCodeWritten,
  projectToolInvocations,
} from "@brewva/brewva-vocabulary/tool-invocations";

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

const REQUIREMENTS_RUNG_INDEX = VERIFICATION_RUNGS.indexOf("requirements");

/**
 * Tape-derived requirement-verification debt for the operator surfaces (the
 * `inspect run-report` marker), sibling to `buildTapeReviewDebt`: the "green
 * below the requirements rung with unverified `must` atoms" pressure the
 * review-debt marker cannot express. Folds the three tape facts the pure
 * `projectUnverifiedRequirementDebt` needs — fresh code was written, how many
 * `must` atoms are still `unverified` (re-derived over the whole tape via
 * `buildTapeRequirementFitness`), and whether ANY pass ever reached the
 * `requirements` rung — and judges once. Advisory only; no filesystem access.
 */
export function buildTapeUnverifiedRequirementDebt(
  events: readonly BrewvaEventRecord[],
): UnverifiedRequirementDebt {
  const freshCodeWritten = projectFreshCodeWritten(projectToolInvocations(events));
  const unverifiedMustCount = buildTapeRequirementFitness(events).unverifiedMustAtoms.length;
  const reachedRequirementsVerify = events.some((event) => {
    if (event.type !== VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      return false;
    }
    const parsed = readVerificationOutcomeRecordedEventPayload(event);
    return (
      parsed.outcome === "pass" &&
      parsed.level !== null &&
      VERIFICATION_RUNGS.indexOf(parsed.level as VerificationRung) >= REQUIREMENTS_RUNG_INDEX
    );
  });
  return projectUnverifiedRequirementDebt({
    freshCodeWritten,
    unverifiedMustCount,
    reachedRequirementsVerify,
  });
}
