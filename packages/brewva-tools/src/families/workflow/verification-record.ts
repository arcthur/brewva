import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { readStringList } from "@brewva/brewva-std/text";
import type {
  BrewvaToolContext as ExtensionContext,
  BrewvaToolDefinition as ToolDefinition,
} from "@brewva/brewva-substrate/tools";
import {
  FITNESS_DISCREPANCY_GRADES,
  projectRequirementFitness,
  projectUnverifiedRequirementDebt,
} from "@brewva/brewva-vocabulary/fitness";
import type { FitnessDiscrepancy, FitnessProjection } from "@brewva/brewva-vocabulary/fitness";
import { VERIFICATION_RUNGS } from "@brewva/brewva-vocabulary/iteration";
import { projectReviewDebt } from "@brewva/brewva-vocabulary/review";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions, BrewvaToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import {
  assembleRequirementFitnessInput,
  assembleReviewDebtInput,
  recordVerificationOutcome,
} from "../../runtime-port/verification.js";
import { readLiteral } from "../../utils/literal.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const OUTCOME_VALUES = ["pass", "fail", "skipped"] as const;

const OutcomeSchema = buildStringEnumSchema(OUTCOME_VALUES, {});
const RungSchema = buildStringEnumSchema(VERIFICATION_RUNGS, {});

const REVIEW_DEBT_MARKER_TEMPLATE =
  "review_debt: authored-only evidence for fresh code (%REASON%) — consider review_request before shipping.";

/** Rank at/above which a `pass` claim earns the claim-time fitness cross-check. */
const REQUIREMENTS_RUNG_INDEX = VERIFICATION_RUNGS.indexOf("requirements");

/**
 * The below-requirements counterpart to the review-debt marker: a `pass` was
 * recorded at a rung BELOW `requirements` while fresh code carries `must`-modality
 * atoms that were never graded against evidence. The review-debt marker cannot
 * express this (it fires only at `requirements`+), so this is the resistance that
 * keeps a build-level green from reading as "done". Advisory only.
 */
function formatUnverifiedRequirementDebtMarker(
  rung: string,
  unverifiedMustAtomIds: readonly string[],
): string {
  return (
    `unverified_requirements: ${unverifiedMustAtomIds.length} must-modality atom(s) ` +
    `[${unverifiedMustAtomIds.join(", ")}] not yet verified — this pass reached rung=${rung} ` +
    `(below requirements). Climb to a requirements-level verify (re-derive each must atom from ` +
    `the code) or record why they are notApplicable before treating this as done.`
  );
}

/** The `deterministic_conflict` grade, named off the exported tuple rather than a bare literal (grade-vocabulary consolidation). */
const DETERMINISTIC_CONFLICT_GRADE = FITNESS_DISCREPANCY_GRADES[0];

/**
 * The one-line fitness summary appended to the result text of an annotated
 * `pass`. Read-only accounting of the projection: how many atoms are satisfied /
 * unverified (of which `must`) / violated, and how many discrepancies (of which
 * deterministic). It changes no receipt — the receipt already carries the full
 * discrepancies + unverified-must lists; this is the human-facing digest.
 */
function formatFitnessSummary(projection: FitnessProjection): string {
  const { counts, discrepancies, unverifiedMustAtoms } = projection;
  const deterministic = discrepancies.filter(
    (entry: FitnessDiscrepancy) => entry.grade === DETERMINISTIC_CONFLICT_GRADE,
  ).length;
  return (
    `fitness: ${counts.satisfied} satisfied / ${counts.unverified} unverified ` +
    `(${unverifiedMustAtoms.length} must) / ${counts.violated} violated; ` +
    `${discrepancies.length} discrepancies (${deterministic} deterministic)`
  );
}

/** Same cwd/workspaceRoot fallback every workflow-family tool that touches the real filesystem uses. */
function resolveWorkspaceRoot(runtime: BrewvaToolRuntime, ctx: ExtensionContext): string {
  const ctxCwd = (ctx as { cwd?: unknown }).cwd;
  if (typeof ctxCwd === "string" && ctxCwd.trim().length > 0) {
    return resolve(ctxCwd);
  }
  if (
    typeof runtime.identity.workspaceRoot === "string" &&
    runtime.identity.workspaceRoot.trim().length > 0
  ) {
    return resolve(runtime.identity.workspaceRoot);
  }
  if (typeof runtime.identity.cwd === "string" && runtime.identity.cwd.trim().length > 0) {
    return resolve(runtime.identity.cwd);
  }
  return process.cwd();
}

/**
 * sha256 of the current on-disk content of a workspace-relative path, for
 * `file_digests` target-ref staleness matching. A missing or unreadable file
 * has no current digest (null), which `reviewTargetRefMatchesTree` already
 * treats as stale by definition.
 */
function readWorkspaceFileDigest(workspaceRoot: string, path: string): string | null {
  try {
    return sha256Hex(readFileSync(resolve(workspaceRoot, path)));
  } catch {
    return null;
  }
}

/**
 * Model-facing producer for the `verification.outcome.recorded` receipt.
 *
 * The receipt is what Work Card Evidence, stall adjudication, and
 * `inspect run-report` read; an unrecorded verification is invisible to every
 * one of them. Recording evidence grants no authority — the tool commits what
 * was checked and what rung of the verification ladder the checks reached.
 */
export function createVerificationRecordTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "verification_record",
  );
  return define(
    {
      name: "verification_record",
      label: "Verification Record",
      description:
        "Commit the verification outcome for the current session as the canonical receipt. " +
        "level names the verification-ladder rung the executed checks actually reached: " +
        "exit_code (command exited 0) < diagnostics (zero or disclosed warnings) < artifact " +
        "(produced artifact structurally validated) < requirements (each requirement " +
        "re-derived from code) < runtime_smoke (behavior probed at runtime).",
      parameters: Type.Object({
        outcome: OutcomeSchema,
        level: RungSchema,
        checks: Type.Optional(Type.Array(Type.String())),
        failedChecks: Type.Optional(Type.Array(Type.String())),
        missingChecks: Type.Optional(Type.Array(Type.String())),
        missingEvidence: Type.Optional(Type.Array(Type.String())),
        reason: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const outcome = readLiteral(params.outcome, OUTCOME_VALUES);
        const level = readLiteral(params.level, VERIFICATION_RUNGS);
        if (!outcome || !level) {
          return errTextResult("verification_record requires outcome and a valid ladder level.", {
            ok: false,
            error: "verification_record_invalid_input",
          });
        }
        const checks = readStringList(params.checks);
        const failedChecks = readStringList(params.failedChecks);
        if (outcome === "fail" && failedChecks.length === 0) {
          return errTextResult(
            "A fail outcome must name at least one failed check so the receipt stays actionable.",
            { ok: false, error: "verification_record_missing_failed_checks" },
          );
        }

        // ANNOTATE, NEVER REFUSE (axiom 18): the fitness projection is a VIEW
        // committed ONTO the receipt, never a gate. It runs only for a `pass` at
        // the `requirements` rung or above (a contradicted claim below that rung,
        // or a non-pass claim, carries no annotation). The projection NEVER
        // changes `outcome` and NEVER errors the call — a `pass` with
        // discrepancies is committed as `pass`, the discrepancies visible as debt.
        // With no requirement atoms, the projection is empty and the summary line
        // is omitted entirely.
        const fitnessGated =
          outcome === "pass" && VERIFICATION_RUNGS.indexOf(level) >= REQUIREMENTS_RUNG_INDEX;
        const fitness = fitnessGated
          ? projectRequirementFitness(assembleRequirementFitnessInput(runtime, sessionId))
          : null;

        const result = await recordVerificationOutcome(runtime, sessionId, {
          outcome,
          level,
          checks,
          failedChecks,
          missingChecks: readStringList(params.missingChecks),
          missingEvidence: readStringList(params.missingEvidence),
          evidenceFreshness: "fresh",
          reason: typeof params.reason === "string" ? params.reason : null,
          // Authorship is a fact of this producer, not an authored claim: the
          // parameter schema above has no perspective/independenceBasis/
          // reviewerContext/targetRef fields, so a model has no way to record
          // itself as independent through this tool.
          perspective: "authored",
          independenceBasis: [],
          reviewerContext: null,
          targetRef: null,
          // Non-tool callers can't reach here; a non-gated claim carries `[]`.
          discrepancies: fitness?.discrepancies ?? [],
          unverifiedMustAtoms: fitness?.unverifiedMustAtoms ?? [],
          // An AUTHORED claim attests to no specific atom (the positive signal is
          // exclusively an independent clear atoms-review's job). Always `[]`.
          atomRefs: [],
        });
        if (!result) {
          return errTextResult("Verification recording is unavailable in this runtime.", {
            ok: false,
            error: "verification_record_unavailable",
          });
        }
        const baseText = `Recorded verification outcome=${outcome} at rung=${level} (${checks.length} checks).`;
        // Omit the fitness line entirely when no atoms exist (nothing to cross-check).
        const resultText =
          fitness && fitness.atoms.length > 0
            ? `${baseText}\n${formatFitnessSummary(fitness)}`
            : baseText;
        // Advisory pressure markers for a `pass` (axiom 18: they change the
        // RESULT TEXT only — never the outcome and never the recorded receipt). A
        // fail/skipped outcome runs neither scan and touches no filesystem.
        const markers: string[] = [];
        if (outcome === "pass") {
          const workspaceRoot = resolveWorkspaceRoot(runtime, ctx);
          const debtInput = assembleReviewDebtInput(
            runtime,
            sessionId,
            { outcome, level },
            workspaceRoot,
            (path) => readWorkspaceFileDigest(workspaceRoot, path),
          );
          // Review debt fires only at `requirements`+: was that pass independently
          // reviewed? It cannot speak to a lower rung.
          const reviewDebt = projectReviewDebt(debtInput);
          if (reviewDebt.debt && reviewDebt.reason) {
            markers.push(REVIEW_DEBT_MARKER_TEMPLATE.replace("%REASON%", reviewDebt.reason));
          }
          // Requirement-verification debt fires only BELOW `requirements`: a green
          // at a lower rung (e.g. `artifact`: does it build/sign?) that never
          // graded the `must` atoms. Mutually exclusive with review debt by rung,
          // so at most one marker appends. The fitness view is disclosure-only —
          // the receipt annotation stays gated to `requirements`+ (above) and is
          // untouched here.
          const belowRequirements = VERIFICATION_RUNGS.indexOf(level) < REQUIREMENTS_RUNG_INDEX;
          if (belowRequirements && debtInput.freshCodeWritten) {
            const belowFitness = projectRequirementFitness(
              assembleRequirementFitnessInput(runtime, sessionId),
            );
            const reqDebt = projectUnverifiedRequirementDebt({
              freshCodeWritten: debtInput.freshCodeWritten,
              unverifiedMustCount: belowFitness.unverifiedMustAtoms.length,
              // The reason arm is not printed on this claim-time surface (the
              // below-requirements gate above IS the rung signal); the run-report
              // operator surface computes the accurate reason over the whole tape.
              reachedRequirementsVerify: false,
            });
            if (reqDebt.debt) {
              markers.push(
                formatUnverifiedRequirementDebtMarker(level, belowFitness.unverifiedMustAtoms),
              );
            }
          }
        }
        const finalText = markers.length > 0 ? `${resultText}\n${markers.join("\n")}` : resultText;
        return okTextResult(finalText, {
          ok: true,
          outcome,
          level,
          checks_recorded: checks.length,
          failed_checks: failedChecks.length,
        });
      },
    },
    {},
  );
}
