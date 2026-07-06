/**
 * The tape-derived review-debt read for the CLI operator surfaces (inspect
 * report, Work Card evidence, run-report verification) is now SINGLE-HOMED in
 * `@brewva/brewva-tools/runtime-port`, shared with the hosted delegation
 * advisory (Lever 2) so the operator and model-facing tail can never diverge on
 * whether open review debt exists. This module re-exports it for the inspect
 * surfaces that import from here.
 *
 * The fold reads the whole tape and judges the latest `verification.outcome.recorded`
 * receipt as the claim, clearing debt only when some independent receipt both
 * matches the current tree AND covers the fresh-touched-file universe (Finding
 * P1-C). The conservative match rule and "which receipt is the claim" choice
 * live in exactly one place inside the shared home.
 */
export { buildTapeReviewDebt } from "@brewva/brewva-tools/runtime-port";
