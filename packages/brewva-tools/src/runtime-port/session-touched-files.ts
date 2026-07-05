import { resolve } from "node:path";
import type { BrewvaToolContext as ExtensionContext } from "@brewva/brewva-substrate/tools";
import { deriveFreshTouchedFileUniverse } from "@brewva/brewva-vocabulary/review";
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
 * The session's FULL fresh-touched-file universe as a normalized path list:
 * the union of applied patch-set `appliedPaths` AND every bare-write (write/edit)
 * invocation's target path — the SAME notion the debt/fitness projections track
 * via the vocabulary's {@link deriveFreshTouchedFileUniverse}. Broader than
 * {@link sessionAppliedTouchedFilePaths} (which is patch-applied files only): an
 * atoms review of a session that finished via bare writes has no patch sets, so
 * its `file_digests` snapshot must cover those bare-write files (Finding P2).
 * Reuses the existing universe derivation — no new touched-files scan. Returns
 * paths in a stable order (patch paths first, then bare-write paths, both
 * first-seen-wins via the underlying Set insertion order).
 *
 * `workspaceRoot` relativizes the bare-write paths: commitment write args are
 * ABSOLUTE, but the resulting `file_digests` receipt must key files
 * workspace-relative so it matches the coverage universe
 * {@link assembleReviewDebtInput} builds (which also relativizes) — otherwise an
 * atoms review of exactly these files could never clear debt on a real hosted
 * tape (Finding P2, absolute-path regression).
 */
export function sessionFreshTouchedFilePaths(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  workspaceRoot: string,
): readonly string[] {
  const records = runtime.capabilities.events?.records;
  const allEvents = records?.query ? records.query(sessionId) : [];
  const patchSetAppliedPaths = collectPatchSetAppliedPaths(allEvents);
  const universe = deriveFreshTouchedFileUniverse({
    appliedPaths: Object.values(patchSetAppliedPaths).flat(),
    // The read-model relativizes the absolute commitment paths against the
    // session root, so the universe files match the review targetRef keys.
    writeInvocationPaths: extractWriteInvocationPaths(
      projectToolInvocations(allEvents),
      workspaceRoot,
    ),
  });
  return [...universe.files];
}
