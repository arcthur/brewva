import {
  RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  type BrewvaEventRecord,
} from "@brewva/brewva-vocabulary/events";
import {
  deriveLatestTreeMutationAt,
  extractWriteInvocationPaths,
  projectFreshCodeWritten,
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  deriveFreshTouchedFileUniverse,
  projectTapeReviewDebt,
  type ReviewDebt,
  type TapeVerificationReceipt,
} from "@brewva/brewva-vocabulary/review";
import {
  collectPatchSetAppliedPaths,
  deriveAppliedPatchSetIds,
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";

/**
 * THE single tape-only review-debt read for every CLI read surface that needs
 * it (inspect report, Work Card evidence, run-report verification) — fold raw
 * session events into `projectTapeReviewDebt`'s inputs exactly once. Lives
 * here (not inside `internal/review.ts`) because folding requires readers
 * from three vocabulary internal modules (`iteration.ts` for the outcome
 * reader and fresh-code scan, `workbench.ts` for applied-patch-set derivation)
 * that already depend on `review.ts` — importing back would be a circular
 * internal-module dependency. This module is the layer above all three where
 * "read the whole tape and judge debt" naturally lives; both CLI surfaces
 * that need it import this instead of re-deriving the fold.
 *
 * Same conservative match rule everywhere: `patch_sets` refs match on
 * set-equality against the tape-derived applied patch sets; `file_digests`
 * refs match only when the tree has not been mutated on the tape since the
 * receipt's own timestamp — where a mutation is any successful patch
 * application, rollback, OR bare write/edit invocation (all rewrite files;
 * Finding P1). Under-claims freshness at worst, never over-claims. No
 * filesystem access — every input is tape-derived.
 */
export function buildTapeReviewDebt(events: readonly BrewvaEventRecord[]): ReviewDebt {
  const tapeVerificationReceipts: TapeVerificationReceipt[] = events
    .filter((event) => event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE)
    .map((event) => {
      const parsed = readVerificationOutcomeRecordedEventPayload(event);
      return {
        timestamp: event.timestamp,
        outcome: parsed.outcome,
        level: parsed.level,
        perspective: parsed.perspective,
        targetRef: parsed.targetRef,
      };
    });
  const invocationStartedEvents = events.filter(
    (event) => event.type === RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND,
  );
  const freshCodeWritten = projectFreshCodeWritten(invocationStartedEvents);
  const patchTapeEvents = events.filter(
    (event) => event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE || event.type === ROLLBACK_EVENT_TYPE,
  );
  const appliedPatchSetRefs = deriveAppliedPatchSetIds(patchTapeEvents);
  // A tree mutation is a successful patch/rollback OR a bare write/edit
  // invocation (Finding P1): all three rewrite the working tree, so any of them
  // must age a `file_digests` ref to stale. Single-homed in
  // `deriveLatestTreeMutationAt` so this read and the requirement-fitness
  // assembler count the exact same mutation set. Failed patch/rollback events
  // and blocked writes never touched the tree and are excluded.
  const latestTreeMutationAt = deriveLatestTreeMutationAt({
    patchRollbackEvents: patchTapeEvents,
    writeInvocationEvents: invocationStartedEvents,
  });
  // Fresh-touched-file universe + per-patch-set attested paths (Finding P1-C).
  // The universe unions every successful patch's `appliedPaths` with the target
  // path of every bare-write (write/edit) invocation; a matching independent
  // receipt clears debt only when it also COVERS the universe. Every input is
  // tape-derived — no filesystem access.
  const patchSetAppliedPaths = collectPatchSetAppliedPaths(events);
  const freshTouchedUniverse = deriveFreshTouchedFileUniverse({
    appliedPaths: Object.values(patchSetAppliedPaths).flat(),
    writeInvocationPaths: extractWriteInvocationPaths(invocationStartedEvents),
  });
  return projectTapeReviewDebt({
    freshCodeWritten,
    receipts: tapeVerificationReceipts,
    appliedPatchSetRefs,
    latestTreeMutationAt,
    freshTouchedUniverse,
    patchSetAppliedPaths,
  });
}
