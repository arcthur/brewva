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
import { VERIFICATION_RUNGS, type EvidenceItem } from "@brewva/brewva-vocabulary/iteration";
import { projectReviewDebt } from "@brewva/brewva-vocabulary/review";
import { foldTaskLedgerEvents } from "@brewva/brewva-vocabulary/task";
import {
  extractWriteInvocationPaths,
  projectToolInvocations,
} from "@brewva/brewva-vocabulary/tool-invocations";
import { collectPatchSetAppliedPaths } from "@brewva/brewva-vocabulary/workbench";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions, BrewvaToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import {
  assembleRequirementFitnessInput,
  assembleReviewDebtInput,
  evidenceItemsToDeterministicEvidence,
  recordVerificationOutcome,
} from "../../runtime-port/verification.js";
import { collectStaticGuardEvidence } from "../../shared/static-guard/producer.js";
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

/** Read the current on-disk source of a workspace path as text, or null. */
function readWorkspaceSource(workspaceRoot: string, path: string): string | null {
  try {
    return readFileSync(resolve(workspaceRoot, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * R3c: the RUNTIME runs the static-guard adapters over the session's fresh-touched
 * source, attributing each verdict through the atoms' DECLARED bindings (a trap
 * entry's `staticGuards` at `property` coverage; the atom's own
 * `observableSignals` construct join at `facet` coverage — see the producer),
 * recording deterministic, `static_guard`-grade results on the receipt. A
 * producer the model cannot fabricate — the predicate runs on the real file; a
 * property PASS can satisfy a high-risk atom presence-only evidence leaves
 * capped, any FAIL is a real `deterministic_conflict`, and an applicable FAIL
 * no atom declares still rides the receipt unbound (empty `atomRefs`). Inert
 * (`[]`) with no atoms, no fresh writes, or no applicable lens.
 */
function collectStaticGuardEvidenceForSession(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  ctx: ExtensionContext,
): EvidenceItem[] {
  const records = runtime.capabilities.events?.records;
  const events = records?.list ? records.list(sessionId) : [];
  const atoms = foldTaskLedgerEvents(events).requirements.map((atom) => ({
    id: atom.id,
    statement: atom.statement,
    provenance: atom.provenance,
    observableSignals: atom.observableSignals,
  }));
  const workspaceRoot = resolveWorkspaceRoot(runtime, ctx);
  const invocations = projectToolInvocations(events);
  const writePaths = extractWriteInvocationPaths(invocations)
    .map((invocation) => invocation.path)
    .filter((path): path is string => path !== null);
  // A session that lands its fix via `source_patch_apply` (not a bare write/edit)
  // touches files whose paths live authoritatively on the `source_patch_applied`
  // receipt, NOT on tool args — union them in (the SAME appliedPaths the
  // review-debt fresh-touched universe uses), so a patched source file is not
  // invisible to the guard, which would silently drop its FAIL evidence.
  const patchPaths = Object.values(collectPatchSetAppliedPaths(events)).flat();
  const sourcePaths = [...new Set([...writePaths, ...patchPaths])];
  return collectStaticGuardEvidence({
    atoms,
    sourcePaths,
    readSource: (path) => readWorkspaceSource(workspaceRoot, path),
  });
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
        // R3c: run the static-guard adapters over the fresh-touched source FIRST (a
        // producer the model cannot fabricate — the runtime runs the predicate on the
        // real file). These items are not on the tape yet (THIS receipt will carry
        // them), so they are injected into the claim-time fitness below; otherwise
        // its `discrepancies` would miss the deterministic_conflict just found.
        const evidenceItems = fitnessGated
          ? collectStaticGuardEvidenceForSession(runtime, sessionId, ctx)
          : [];
        const fitness = fitnessGated
          ? projectRequirementFitness(
              assembleRequirementFitnessInput(runtime, sessionId, {
                deterministicEvidence: evidenceItemsToDeterministicEvidence(evidenceItems),
              }),
            )
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
          // Deterministic static-guard results (R3c): NOT an authored atom claim —
          // the runtime ran the predicate, so a `deterministic` PASS is trustworthy
          // and can satisfy a high-risk atom regardless of this receipt's perspective.
          evidenceItems,
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
        // UNBOUND deterministic FAILs (empty atomRefs): real static-guard
        // conflicts no requirement atom declares. They move no atom state by
        // design (attribution unknown is said, not guessed — axiom 7), so the
        // receipt is their ONLY surface; without this marker the signal would be
        // write-only. Text-only, like every marker here.
        const unboundFails = evidenceItems.filter(
          (item) => item.atomRefs.length === 0 && item.verdict === "fail",
        );
        if (unboundFails.length > 0) {
          markers.push(
            `UNBOUND DETERMINISTIC CONFLICTS (no requirement atom declares these constructs — fix or claim them via observableSignals):\n${unboundFails
              .map((item) => `- ${item.id}: ${item.anchors[0] ?? item.statement}`)
              .join("\n")}`,
          );
        }
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
