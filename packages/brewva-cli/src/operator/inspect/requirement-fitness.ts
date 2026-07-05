/**
 * The tape-derived requirement-fitness reads for the CLI operator surfaces
 * (`inspect run-report`'s Fitness section, the Work Card fitness line) are now
 * SINGLE-HOMED in `@brewva/brewva-tools/runtime-port`, shared with the hosted
 * runtime brief (R4) so the operator and model-facing views can never diverge on
 * what the tape says about requirement fitness and debt. This module re-exports
 * them for the inspect surfaces that import from here.
 *
 * Re-deriving the CURRENT fitness over the WHOLE tape (not the latest receipt's
 * frozen annotation) matters for two reasons — a clear INDEPENDENT atoms-review
 * commits its `satisfied` after the authored verify, and the latest receipt after
 * any review is the independent one whose claim-time annotation is empty by design
 * (axiom 6). Both are handled inside the shared home.
 */
export {
  buildTapeRequirementFitness,
  buildTapeUnverifiedRequirementDebt,
} from "@brewva/brewva-tools/runtime-port";
