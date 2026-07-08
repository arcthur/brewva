import { resolve } from "node:path";
import type { BrewvaToolContext as ExtensionContext } from "@brewva/brewva-substrate/tools";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  attestedFilesForRef,
  deriveFreshTouchedFileUniverse,
  universeCoveredBy,
} from "@brewva/brewva-vocabulary/review";
import type { FreshTouchedFileUniverse, ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import {
  extractWriteInvocationPaths,
  projectToolInvocations,
} from "@brewva/brewva-vocabulary/tool-invocations";
import {
  collectPatchSetAppliedPaths,
  deriveAppliedPatchSetIds,
  ROLLBACK_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type { BrewvaToolRuntime } from "../contracts/index.js";

/**
 * Single home for "which files did this session's applied patch sets touch,"
 * shared by every tool-level caller that needs the same narrow notion of
 * session-touched files `review_request`'s `session_diff` target already
 * established: the union of `appliedPaths` on every `source_patch_applied`
 * receipt whose patch set is currently applied (not rolled back). This is
 * deliberately narrower than the vocabulary's full `FreshTouchedFileUniverse`
 * (which also folds in bare write/edit invocation paths) — Task 9's card
 * source and lens-preload both want exactly "files the session's applied
 * patch sets touched," matching what `review_request`'s own `session_diff`
 * target already snapshots, so this reuses the identical patch-set-applied
 * derivation instead of introducing a second, broader notion of "touched."
 */

/** Same cwd/workspaceRoot fallback chain `review_request` and the workflow family use for real filesystem access. */
export function resolveWorkspaceRoot(runtime: BrewvaToolRuntime, ctx: ExtensionContext): string {
  const ctxCwd = (ctx as { cwd?: unknown }).cwd;
  if (typeof ctxCwd === "string" && ctxCwd.trim().length > 0) {
    return resolve(ctxCwd);
  }
  const identity = runtime.identity as BrewvaToolRuntime["identity"] | undefined;
  if (typeof identity?.workspaceRoot === "string" && identity.workspaceRoot.trim().length > 0) {
    return resolve(identity.workspaceRoot);
  }
  if (typeof identity?.cwd === "string" && identity.cwd.trim().length > 0) {
    return resolve(identity.cwd);
  }
  return process.cwd();
}

/**
 * The session's patch-applied/rollback events, in tape order — the raw scan
 * both helpers below fold over. Uses `records.query` (not `.list`): the two
 * are the same underlying read (the hosted runtime's `queryEvents` is
 * `listEvents` under another name), but every existing caller of this shared
 * module — `attention_options`'s already-declared capability set only
 * includes `.query` — needs exactly one declared read capability, not two
 * names for the identical operation.
 */
function patchLifecycleEvents(runtime: BrewvaToolRuntime, sessionId: string) {
  const records = runtime.capabilities.events?.records;
  const events = records?.query ? records.query(sessionId) : [];
  return events.filter(
    (event) => event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE || event.type === ROLLBACK_EVENT_TYPE,
  );
}

/**
 * Applied-minus-rolled-back patch-set ids for the session, from the raw tape
 * order. THE single derivation `review_request`'s `session_diff` targetRef
 * snapshot and {@link sessionAppliedTouchedFilePaths} below both use — one
 * scan of the patch lifecycle events, not two independently-drifting copies.
 */
export function sessionAppliedPatchSetIds(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): readonly string[] {
  return deriveAppliedPatchSetIds(patchLifecycleEvents(runtime, sessionId));
}

/**
 * Deterministic, deduplicated list of file paths touched by the session's
 * currently-applied patch sets (tape order: the order `appliedPaths` arrives
 * across patch-applied receipts, first-seen-wins). Rolled-back patch sets
 * contribute nothing, mirroring {@link sessionAppliedPatchSetIds}'s own
 * applied-minus-rolled-back rule.
 */
export function sessionAppliedTouchedFilePaths(
  runtime: BrewvaToolRuntime,
  sessionId: string,
): readonly string[] {
  const events = patchLifecycleEvents(runtime, sessionId);
  const applied = new Set(deriveAppliedPatchSetIds(events));
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== SOURCE_PATCH_APPLIED_EVENT_TYPE) {
      continue;
    }
    const payload = event.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload as { ok?: unknown; patchSetId?: unknown; appliedPaths?: unknown };
    if (record.ok !== true || typeof record.patchSetId !== "string") {
      continue;
    }
    if (!applied.has(record.patchSetId)) {
      continue;
    }
    if (!Array.isArray(record.appliedPaths)) {
      continue;
    }
    for (const path of record.appliedPaths) {
      if (typeof path === "string" && path.length > 0 && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

/**
 * THE single derivation of the session's fresh-touched-file universe from an event
 * list: the union of applied patch-set `appliedPaths` and every bare-write target
 * path, via the vocabulary's {@link deriveFreshTouchedFileUniverse}. Returns the
 * `patchSetAppliedPaths` map alongside the universe so a coverage caller can also
 * resolve a `patch_sets` ref's attested files WITHOUT re-scanning the tape. Pure over
 * the events; `workspaceRoot` relativizes the absolute commitment write paths so the
 * universe keys match the workspace-relative review targetRef keys. Shared by
 * {@link sessionFreshTouchedFilePaths} and {@link freshTouchedCoverageForTargetRef}
 * so the universe rule has ONE home (`assembleReviewDebtInput` keeps its own `.list`
 * twin — a different declared capability — acknowledged there).
 */
function deriveSessionFreshTouchedUniverse(
  events: readonly BrewvaEventRecord[],
  workspaceRoot: string,
): {
  universe: FreshTouchedFileUniverse;
  patchSetAppliedPaths: ReturnType<typeof collectPatchSetAppliedPaths>;
} {
  const patchSetAppliedPaths = collectPatchSetAppliedPaths(events);
  const universe = deriveFreshTouchedFileUniverse({
    appliedPaths: Object.values(patchSetAppliedPaths).flat(),
    // The read-model relativizes the absolute commitment paths against the session
    // root, so the universe files match the review targetRef keys.
    writeInvocationPaths: extractWriteInvocationPaths(
      projectToolInvocations(events),
      workspaceRoot,
    ),
  });
  return { universe, patchSetAppliedPaths };
}

/**
 * The session's full fresh-touched-file universe as a normalized path list — broader
 * than {@link sessionAppliedTouchedFilePaths} (patch-applied files only) because it
 * also folds in bare write/edit target paths, so an atoms review of a bare-write
 * session can still snapshot and clear debt over exactly those files (Finding P2).
 * A thin path-list view over {@link deriveSessionFreshTouchedUniverse}.
 */
export function sessionFreshTouchedFilePaths(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  workspaceRoot: string,
): readonly string[] {
  const records = runtime.capabilities.events?.records;
  const allEvents = records?.query ? records.query(sessionId) : [];
  return [...deriveSessionFreshTouchedUniverse(allEvents, workspaceRoot).universe.files];
}

export interface FreshTouchedCoverage {
  /** The session's fresh-touched-file universe: bare writes + applied patches. */
  readonly universe: FreshTouchedFileUniverse;
  /** True iff the targetRef's attested files ⊇ the (fully-known) universe. */
  readonly covered: boolean;
}

/**
 * The ONE coverage rule: does a review's `targetRef` attest a file set that COVERS the
 * session's fresh-touched universe? A `file_digests` ref attests its digested paths; a
 * `patch_sets` ref attests the union of its applied paths; coverage holds iff that
 * attested set ⊇ the universe (bare writes included) AND the universe is fully known.
 * Pure over precomputed inputs — the SINGLE covers definition shared by the review→atom
 * fold's `.query` gate ({@link freshTouchedCoverageForTargetRef}) and the review-debt
 * `.list` gate (`assembleReviewDebtInput.covers` in verification.ts), so the two can no
 * longer drift. An empty universe is trivially covered; a caller that must reject an
 * empty universe reads the universe directly (as the fold does).
 */
export function targetRefCoversFreshUniverse(
  universe: FreshTouchedFileUniverse,
  patchSetAppliedPaths: ReturnType<typeof collectPatchSetAppliedPaths>,
  targetRef: ReviewTargetRef,
): boolean {
  return universeCoveredBy(
    attestedFilesForRef(targetRef, (id) => patchSetAppliedPaths[id] ?? []),
    universe,
  );
}

/**
 * The session's fresh-touched universe AND whether a review's `targetRef` covers it,
 * for the review→atom fold's honest-scoping gate. Pure over the event list (the caller
 * supplies the single `records.query` read); the coverage decision runs through the
 * shared {@link targetRefCoversFreshUniverse}. The `universe` rides back out so callers
 * can distinguish "covered because there is nothing to cover" (empty universe —
 * trivially covered, no fresh implementation to attest against) from real coverage; the
 * review→atom fold rejects an empty universe by reading it directly.
 */
export function freshTouchedCoverageForTargetRef(
  events: readonly BrewvaEventRecord[],
  workspaceRoot: string,
  targetRef: ReviewTargetRef,
): FreshTouchedCoverage {
  const { universe, patchSetAppliedPaths } = deriveSessionFreshTouchedUniverse(
    events,
    workspaceRoot,
  );
  return {
    universe,
    covered: targetRefCoversFreshUniverse(universe, patchSetAppliedPaths, targetRef),
  };
}
