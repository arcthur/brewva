import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  projectRequirementFitness,
  projectUnverifiedRequirementDebt,
  type DeterministicFitnessEvidence,
  type FitnessDiscrepancy,
  type FitnessIndependentOutcome,
  type FitnessProjection,
  type FitnessReviewFinding,
  type RequirementFitnessInput,
  type UnverifiedRequirementDebt,
} from "@brewva/brewva-vocabulary/fitness";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_RUNGS,
  type EvidenceItem,
  type VerificationRung,
} from "@brewva/brewva-vocabulary/iteration";
import {
  attestedFilesForRef,
  deriveFreshTouchedFileUniverse,
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
  reviewTargetRefMatchesTree,
  universeCoveredBy,
  type IndependenceBasis,
  type ReviewDebtInput,
  type ReviewerContext,
  type ReviewTargetRef,
  type VerificationPerspective,
} from "@brewva/brewva-vocabulary/review";
import { foldTaskLedgerEvents, type RequirementAtom } from "@brewva/brewva-vocabulary/task";
import {
  deriveLatestTreeMutationAt,
  extractWriteInvocationPaths,
  projectFreshCodeWritten,
  projectToolInvocations,
} from "@brewva/brewva-vocabulary/tool-invocations";
import {
  collectPatchSetAppliedPaths,
  deriveAppliedPatchSetIds,
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type { BrewvaToolRuntime, RecordReviewFindingInput } from "../contracts/index.js";

/**
 * The minimal runtime slice verification recording needs. Named so the
 * gateway's finalization observer (which holds `runtime.ops` — the same
 * capabilities port plus gateway extensions) can call the shared review
 * receipt-commit path as `{ capabilities: runtime.ops }` without a cast:
 * one write seam, two honest callers.
 */
export type VerificationRecordingRuntime = Pick<BrewvaToolRuntime, "capabilities">;

export interface RecordVerificationOutcomeInput {
  readonly outcome: "pass" | "fail" | "skipped";
  readonly level: string;
  readonly checks: readonly string[];
  readonly failedChecks: readonly string[];
  readonly missingChecks: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly evidenceFreshness: string;
  readonly reason: string | null;
  readonly perspective: VerificationPerspective;
  readonly independenceBasis: readonly IndependenceBasis[];
  readonly reviewerContext: ReviewerContext | null;
  readonly targetRef: ReviewTargetRef | null;
  /** Claim-time fitness annotation; both `[]` for non-`requirements`+/non-`pass` claims and no-atoms. */
  readonly discrepancies: readonly FitnessDiscrepancy[];
  readonly unverifiedMustAtoms: readonly string[];
  /**
   * The atoms this outcome affirmatively attests to (a clear independent
   * atoms-review's reviewed atom ids); `[]` on every other outcome. A fail
   * NEVER lists atoms — findings own violations.
   */
  readonly atomRefs: readonly string[];
  /**
   * Structured graded evidence items (R3). Supplied by a graded producer (the
   * static-guard guard-check tool); the authored `verification_record` path omits
   * it, so a model cannot fabricate a `deterministic` static-guard result here.
   */
  readonly evidenceItems?: readonly EvidenceItem[];
}

/**
 * Commits the caller-computed verification outcome as the canonical
 * `verification.outcome.recorded` receipt. Returns undefined when the runtime
 * does not expose the verification capability (fail-closed per managed-tool
 * doctrine: recording is unavailable rather than silently dropped).
 */
export function recordVerificationOutcome(
  runtime: VerificationRecordingRuntime,
  sessionId: string,
  input: RecordVerificationOutcomeInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["verification"]["checks"]["verify"]> | undefined {
  return runtime.capabilities.verification?.checks?.verify(sessionId, input);
}

/**
 * Commits one `review.finding.recorded` receipt through the finding-record
 * seam. Returns undefined when the runtime does not expose the capability
 * (fail-closed per managed-tool doctrine, matching `recordVerificationOutcome`):
 * a finding that can not be recorded is unavailable, not silently dropped.
 */
export function recordReviewFinding(
  runtime: VerificationRecordingRuntime,
  sessionId: string,
  input: RecordReviewFindingInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["verification"]["findings"]["record"]> | undefined {
  return runtime.capabilities.verification?.findings?.record(sessionId, input);
}

/**
 * Assembles the `ReviewDebtInput` the review-debt projection needs, from the
 * capabilities `verification_record` already holds plus a caller-supplied
 * `fileDigest` reader (workspace file access is a tool-family concern, not a
 * runtime-port one — this module stays capability-query-only).
 *
 * `claim` is the pass being recorded RIGHT NOW, not the tape's previous
 * latest receipt: the projection judges the in-flight claim.
 */
export function assembleReviewDebtInput(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  claim: ReviewDebtInput["claim"],
  workspaceRoot: string,
  fileDigest: (path: string) => string | null,
): ReviewDebtInput {
  const records = runtime.capabilities.events?.records;
  // Read the full unfiltered tape ONCE and project from it. `projectToolInvocations`
  // self-filters to the commitment boundary (`tool.committed`) — the authoritative
  // "a tool ran" fact; the hosted managed-session path does not emit the runtime-
  // ops `tool.invocation.started` annotation, so reading THAT left this projection
  // blind on every real tape. The full tape is also what the patch fold below
  // needs: tape order matters (deriveAppliedPatchSetIds processes strictly in
  // array order), so a same-millisecond apply/rollback pair must not be reordered
  // by a per-type-query timestamp merge. Same event source everywhere the read
  // model is folded (assembleRequirementFitnessInput and buildTapeReviewDebt).
  const allEvents = records?.list ? records.list(sessionId) : [];
  const invocations = projectToolInvocations(allEvents);
  const freshCodeWritten = projectFreshCodeWritten(invocations);

  const outcomeEvents = records?.list
    ? records.list(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
    : [];
  const independentReceipts = outcomeEvents
    .map((event) => readVerificationOutcomeRecordedEventPayload(event))
    .filter((payload) => payload.perspective === "independent")
    .map((payload) => ({ targetRef: payload.targetRef }));

  const appliedEvents = allEvents.filter(
    (event) => event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE || event.type === ROLLBACK_EVENT_TYPE,
  );
  const appliedPatchSetRefs = deriveAppliedPatchSetIds(appliedEvents);

  // Fresh-touched-file universe + coverage (Finding P1-C). The universe unions
  // every successful patch's `appliedPaths` with the target path of every
  // bare-write (write/edit) invocation; a matching independent receipt clears
  // debt only when it also COVERS that universe. patch_sets attested files come
  // from the per-patch-set appliedPaths map below.
  const patchSetAppliedPaths = collectPatchSetAppliedPaths(allEvents);
  const appliedPathsUnion = Object.values(patchSetAppliedPaths).flat();
  const freshTouchedUniverse = deriveFreshTouchedFileUniverse({
    appliedPaths: appliedPathsUnion,
    // Commitment write paths are absolute; the read-model relativizes them
    // against the workspace root so the coverage set matches the review
    // targetRef keys (otherwise coverage could never clear).
    writeInvocationPaths: extractWriteInvocationPaths(invocations, workspaceRoot),
  });
  const appliedPathsForPatchSet = (patchSetId: string): readonly string[] =>
    patchSetAppliedPaths[patchSetId] ?? [];

  return {
    freshCodeWritten,
    claim,
    independentReceipts,
    matchesTree: (ref) => reviewTargetRefMatchesTree(ref, { appliedPatchSetRefs, fileDigest }),
    freshTouchedUniverse,
    covers: (ref) =>
      universeCoveredBy(attestedFilesForRef(ref, appliedPathsForPatchSet), freshTouchedUniverse),
  };
}

/**
 * Fold graded {@link EvidenceItem}s into {@link DeterministicFitnessEvidence} — one
 * per (item, atomRef) pair. SINGLE-HOMED: both the tape assembler (reading
 * committed receipts) and the claim-time producer (`verification_record`, whose
 * items are not on the tape yet) map items through this, so the two never drift.
 */
export function evidenceItemsToDeterministicEvidence(
  items: readonly EvidenceItem[],
): DeterministicFitnessEvidence[] {
  return items.flatMap((item) =>
    item.atomRefs.map((atomId) => ({
      atomId,
      verdict: item.verdict,
      ref: item.id,
      evidenceKind: item.evidenceKind,
    })),
  );
}

/**
 * Claim-time-only injected evidence the tape does not yet carry. When
 * `verification_record` runs the static-guard producer, the resulting items are
 * NOT yet on the tape (this very receipt will carry them), so the claim-time
 * fitness cross-check must be handed them directly — otherwise the receipt's own
 * `discrepancies` annotation (and the summary shown to the model) would miss a
 * `deterministic_conflict` the static-guard run just found. A pure tape
 * re-derivation (`buildTapeRequirementFitness`) reads the same evidence back from
 * committed `evidenceItems`, so it passes no options.
 */
export interface RequirementFitnessAssemblyOptions {
  readonly deterministicEvidence?: readonly DeterministicFitnessEvidence[];
}

/**
 * Assembles the pure {@link RequirementFitnessInput} for `projectRequirementFitness`
 * from current tape state, mirroring {@link assembleReviewDebtInput}'s pattern:
 * capability-query-only, NO filesystem — every matcher input is tape-derived
 * (the projection's `file_digests` staleness uses `latestTreeMutationAt`, not a
 * real digest, exactly like the tape-only review-debt read).
 *
 * Atoms fold from the task ledger (`foldTaskLedgerEvents`). Findings come from
 * `review.finding.recorded`, each paired with ITS OWN receipt timestamp so the
 * projection's per-finding staleness check matches the review-debt discipline.
 *
 * Independent outcomes are fed from each `independent`-perspective
 * `verification.outcome.recorded` receipt's `atomRefs` (a clear atoms-review's
 * `pass` names the reviewed atoms, so `satisfied` is reachable in production; a
 * fail is inert — findings own violations). Deterministic evidence is fed from
 * every receipt's graded `evidenceItems` — the static-guard producer's results,
 * which the runtime ran over real source (not a caller-supplied claim).
 *
 * Remaining honest gap: authored coverage (`likelySatisfied`) has no producer —
 * a future author-attestation channel would feed `authoredOutcomes`.
 */
export function assembleRequirementFitnessInput(
  runtime: VerificationRecordingRuntime,
  sessionId: string,
  options: RequirementFitnessAssemblyOptions = {},
): RequirementFitnessInput {
  const records = runtime.capabilities.events?.records;
  const allEvents = records?.list ? records.list(sessionId) : [];
  return assembleRequirementFitnessInputFromEvents(allEvents, options);
}

/**
 * The pure {@link RequirementFitnessInput} assembler over a raw tape event list.
 * THE single fold both the runtime path ({@link assembleRequirementFitnessInput})
 * and the CLI operator surfaces re-derive through — the latter
 * (`buildTapeRequirementFitness`) rebuilds the CURRENT fitness from the whole
 * tape so a later independent atoms-review's `satisfied` surfaces (axiom 6:
 * views rebuild from receipts), where reading only the latest receipt's frozen
 * annotation misses it — and worse, mis-reads an independent receipt's empty
 * annotation as "nothing unverified".
 */
export function assembleRequirementFitnessInputFromEvents(
  allEvents: readonly BrewvaEventRecord[],
  options: RequirementFitnessAssemblyOptions = {},
): RequirementFitnessInput {
  const atoms: readonly RequirementAtom[] = foldTaskLedgerEvents(allEvents).requirements;

  const findings: FitnessReviewFinding[] = [];
  const independentOutcomes: FitnessIndependentOutcome[] = [];
  // Graded deterministic evidence (R3): each static-guard result arrives as an
  // evidence item and joins at its recorded grade. Tape-committed items come from
  // the receipts below; claim-time items (not on the tape yet) arrive via options.
  const deterministicEvidence: DeterministicFitnessEvidence[] = options.deterministicEvidence
    ? [...options.deterministicEvidence]
    : [];
  for (const [index, event] of allEvents.entries()) {
    if (event.type === REVIEW_FINDING_RECORDED_EVENT_TYPE) {
      const finding = readReviewFindingRecordedEventPayload(event);
      if (finding) {
        findings.push({ finding, receiptTimestamp: event.timestamp });
      }
      continue;
    }
    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      const payload = readVerificationOutcomeRecordedEventPayload(event);
      // Only INDEPENDENT outcomes carry the affirmative atom signal; an authored
      // claim never attests to atoms. A pass with a non-empty atomRefs is the
      // only entry that can reach `satisfied`; a fail is inert here — findings,
      // not the outcome, own the violation. The ref is a stable deterministic id
      // (the reviewer contextId, falling back to the tape position) so the
      // projection's evidence is order-independent.
      if (payload.perspective === "independent") {
        const verdict = payload.outcome === "pass" ? "pass" : "fail";
        independentOutcomes.push({
          // Clear-only enforced HERE too, not just at the producer: the
          // projection blanket-violates every atomRef on a fail outcome
          // (fitness.ts), so a non-pass verdict must carry no atomRefs. The
          // producer already guarantees this; dropping them again at the
          // consumption point makes the invariant locally checked rather than
          // globally trusted, so a future producer regression cannot reach
          // blanket-violation through this seam.
          atomRefs: verdict === "pass" ? payload.atomRefs : [],
          verdict,
          ref: payload.reviewerContext?.contextId ?? `independent-outcome-${index}`,
        });
      }
      // R3: structured graded evidence items are DETERMINISTIC by construction (the
      // runtime ran a static-guard predicate over real source), so each feeds the
      // deterministic side of the join at its recorded grade, regardless of the
      // receipt's perspective. A pass at `static_guard`+ can clear a high-risk atom
      // a presence re-grep cannot; a fail is a real `deterministic_conflict`.
      // Independent evidence rides the top-level `atomRefs` above, not items — one
      // home per source, so there is nothing to double-count.
      deterministicEvidence.push(...evidenceItemsToDeterministicEvidence(payload.evidenceItems));
    }
  }

  // Tape-order-sensitive apply/rollback fold (see assembleReviewDebtInput): read
  // the whole tape and filter client-side so a same-millisecond apply/rollback
  // pair is never misordered by a timestamp merge.
  const appliedEvents = allEvents.filter(
    (event) => event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE || event.type === ROLLBACK_EVENT_TYPE,
  );
  const appliedPatchSetRefs = deriveAppliedPatchSetIds(appliedEvents);
  // A successful patch/rollback OR a bare write/edit commitment ages the tree
  // (Finding P1): all three rewrite files, so any must stale a file_digests
  // finding. Single-homed in `deriveLatestTreeMutationAt` — the SAME mutation
  // set the tape-only review-debt read uses. A bare edit that finished the
  // session (no patches) must age the tree, or a stale file_digests finding
  // would wrongly count as live reviewer counter-evidence. Same
  // `projectToolInvocations(<full tape>)` fold as assembleReviewDebtInput and
  // buildTapeReviewDebt — one shape everywhere.
  const invocations = projectToolInvocations(allEvents);
  const latestTreeMutationAt = deriveLatestTreeMutationAt({
    patchRollbackEvents: appliedEvents,
    writeInvocations: invocations,
  });

  return {
    atoms,
    findings,
    independentOutcomes,
    // Authored coverage (`likelySatisfied`) remains an unwired gap — see the doc
    // comment; deterministic evidence is now fed from receipt `evidenceItems`.
    authoredOutcomes: [],
    deterministicEvidence,
    appliedPatchSetRefs,
    latestTreeMutationAt,
  };
}

const REQUIREMENTS_RUNG_INDEX = VERIFICATION_RUNGS.indexOf("requirements");

/**
 * Re-derive the CURRENT requirement fitness over the whole tape — THE single
 * tape-derived fitness read shared by the CLI operator surfaces and the hosted
 * runtime brief (both import it from here, so they can never diverge). Re-derives
 * (axiom 6) rather than reading the latest receipt's frozen annotation, so a later
 * independent atoms-review's `satisfied` surfaces.
 */
export function buildTapeRequirementFitness(
  events: readonly BrewvaEventRecord[],
): FitnessProjection {
  return projectRequirementFitness(assembleRequirementFitnessInputFromEvents(events));
}

/**
 * The requirement fitness AND its below-requirements debt from ONE fitness
 * derivation — the shape both the operator surfaces and the model-facing brief
 * need. Deriving fitness once here removes the double-derivation the earlier
 * per-surface helper incurred (fitness computed for the count, then again inside
 * the debt fold).
 */
export interface TapeRequirementDebtSummary {
  readonly fitness: FitnessProjection;
  readonly debt: UnverifiedRequirementDebt;
}

export function buildTapeRequirementDebtSummary(
  events: readonly BrewvaEventRecord[],
): TapeRequirementDebtSummary {
  const fitness = buildTapeRequirementFitness(events);
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
  const debt = projectUnverifiedRequirementDebt({
    freshCodeWritten: projectFreshCodeWritten(projectToolInvocations(events)),
    unverifiedMustCount: fitness.unverifiedMustAtoms.length,
    reachedRequirementsVerify,
  });
  return { fitness, debt };
}

/**
 * Tape-derived below-requirements requirement-verification debt — the operator
 * surface read (`inspect run-report`). Thin over {@link
 * buildTapeRequirementDebtSummary}, single-homing the reachedRequirements fold.
 */
export function buildTapeUnverifiedRequirementDebt(
  events: readonly BrewvaEventRecord[],
): UnverifiedRequirementDebt {
  return buildTapeRequirementDebtSummary(events).debt;
}
