import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import type { ReviewFindingSeverity, ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import { REVIEW_FINDING_SEVERITIES } from "@brewva/brewva-vocabulary/review";
import { foldTaskLedgerEvents } from "@brewva/brewva-vocabulary/task";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";
import type {
  BrewvaToolRuntime,
  DelegationOutcomeFinding,
  DelegationPacket,
  ReviewLaneDisposition,
} from "../../contracts/index.js";
import {
  freshTouchedCoverageForTargetRef,
  sessionAppliedPatchSetIds,
  sessionAppliedTouchedFilePaths,
  sessionFreshTouchedFilePaths,
} from "../../runtime-port/session-touched-files.js";
import { buildTapeRequirementFitness } from "../../runtime-port/verification.js";
import { matchFileAgainstWriteVerifyTraps } from "../../shared/trap-library/index.js";
import { normalizeReviewFindingSeverity } from "./review-receipts.js";

/**
 * Pure, runtime-read-only packet/snapshot helpers for `review_request`
 * (extracted from `review-request.ts` per the W1 wave review's deferral: "when
 * the atom-target arm lands, so the seam is drawn once with full target-shape
 * knowledge" — that arm is `AtomsTarget` below). Every function here is a
 * total function of its explicit parameters — no module-level mutable state,
 * no closures over the tool's `execute` scope. `review-request.ts` keeps the
 * tool definition, param reading, and `execute` orchestration; this module
 * keeps everything that turns params + tape reads into a targetRef, an
 * objective, and a result summary.
 */

/** The reviewer must read the targets itself; keep its injected context tight. */
const REVIEW_CONTEXT_BUDGET = { maxInjectionTokens: 4000 } as const;

export type FilesTarget = {
  readonly kind: "files";
  readonly paths: readonly string[];
};
export type SessionDiffTarget = { readonly kind: "session_diff" };
/**
 * Review the session's requirement atoms — every folded atom, or the
 * caller-listed subset — against the session's touched files. An atoms review
 * is honestly a review of "what changed," framed around specific requirements
 * rather than an open diff. It snapshots `patch_sets` when applied sets exist,
 * ELSE falls back to a `file_digests` snapshot over the session's fresh-touched
 * files (Finding P2) so a session that finished via bare write/edit can still
 * run an atoms-level review and produce the `atomRefs` that close the fitness
 * loop. It fails closed only when there is nothing touched at all.
 */
export type AtomsTarget = {
  readonly kind: "atoms";
  readonly atomIds?: readonly string[];
};
export type ReviewTarget = FilesTarget | SessionDiffTarget | AtomsTarget;

export interface ReviewParams {
  readonly target: ReviewTarget;
  readonly lenses: readonly string[];
  readonly stance: string;
  /**
   * True when the caller replaced the default open adversarial stance wholesale.
   * Kept distinct from `stance` so the outcome receipt can label its `checks`
   * honestly: a custom stance must NOT be recorded as `open_adversarial_stance`.
   */
  readonly stanceOverridden: boolean;
  readonly modelHint: string | undefined;
  readonly waitMode: "completion" | "start";
}

export type SnapshotResult =
  | { readonly ok: true; readonly targetRef: ReviewTargetRef }
  | { readonly ok: false; readonly message: string };

function readFileDigest(workspaceRoot: string, path: string): string | null {
  try {
    return sha256Hex(readFileSync(resolve(workspaceRoot, path)));
  } catch {
    return null;
  }
}

/** Same read-and-swallow shape as {@link readFileDigest}, for lens preloading — content, not a digest. */
function readFileTextOrNull(workspaceRoot: string, path: string): string | null {
  try {
    return readFileSync(resolve(workspaceRoot, path), "utf8");
  } catch {
    return null;
  }
}

/**
 * The atoms a target resolves to (folded from the tape, filtered to the
 * caller's `atomIds` when given). Shared by the objective builder (which
 * needs the statements) and the tool's fail-closed empty-target check (which
 * needs only the count) — one fold, not two independently-drifting reads.
 * Folding the WHOLE tape mirrors every other tape-derived helper in this
 * module (`sessionAppliedPatchSetIds`, `sessionAppliedTouchedFilePaths`): a
 * read, never a re-derivation of a receipt's own committed fields.
 */
export function resolveAtomsForTarget(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  target: AtomsTarget,
): readonly RequirementAtom[] {
  const records = runtime.capabilities.events?.records;
  const events = records?.query ? records.query(sessionId) : [];
  const atoms = foldTaskLedgerEvents(events).requirements;
  if (!target.atomIds || target.atomIds.length === 0) {
    return atoms;
  }
  const wanted = new Set(target.atomIds);
  return atoms.filter((atom) => wanted.has(atom.id));
}

/**
 * The outstanding independence-debt atoms to FOLD into a covering `files` or
 * `session_diff` review — the review→atom attribution close-edge. Returns them
 * ONLY when the review's `targetRef` provably covers the whole fresh-touched
 * universe: a {@link RequirementAtom} carries no file anchors, so all debt can be
 * honestly attested only by a review that covers all touched files; a narrow
 * subset stays atom-free. Empty when nothing is covered or no debt is owed. One
 * `records.query` read feeds the coverage gate, the debt set, and the atom objects.
 *
 * Grade ceiling (per the review→atom RFC): the debt atoms are high-risk by
 * construction, so a reviewer CLEAR only moves them to `likelySatisfied` — it does
 * NOT discharge them. The fold pays off on a FAIL, which names the violated atom so
 * it drops out of the debt set. Clearing to `satisfied` is the static-guard
 * producer's job, not a presence-grade review's.
 */
export function resolveFoldedDebtAtoms(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  workspaceRoot: string,
  targetRef: ReviewTargetRef,
): readonly RequirementAtom[] {
  const records = runtime.capabilities.events?.records;
  const events = records?.query ? records.query(sessionId) : [];
  const { universe, covered } = freshTouchedCoverageForTargetRef(events, workspaceRoot, targetRef);
  // Honest scoping with a non-empty guard: fold only into a review that covers the
  // session's FRESH code. An empty universe (no tool-written files this turn) is
  // "trivially covered" yet has no fresh implementation to attest against — folding
  // there would fabricate an attestation over code the reviewer was never asked to
  // read, and a subsequent CLEAR would cheat the coarse requirement-debt down.
  // Require a real (fully-known, non-empty) covered universe.
  if (!covered || universe.files.size === 0) {
    return [];
  }
  const debtIds = new Set(buildTapeRequirementFitness(events).independenceDebtAtoms);
  if (debtIds.size === 0) {
    return [];
  }
  return foldTaskLedgerEvents(events).requirements.filter((atom) => debtIds.has(atom.id));
}

/**
 * The actual file paths a target names, for trap-lens preloading — as
 * distinct from `ReviewTargetRef` (which for `patch_sets` carries only
 * patch-set ids, not paths). A `files` target's paths are already known; a
 * `session_diff` or `atoms` target re-derives them from the same
 * applied-patch-set paths `sessionAppliedTouchedFilePaths` exposes (the
 * identical file set both targets review, per {@link snapshotTargetRef}'s
 * `patch_sets` ref).
 */
export function reviewTargetFilePaths(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  target: ReviewTarget,
): readonly string[] {
  return target.kind === "files"
    ? target.paths
    : sessionAppliedTouchedFilePaths(runtime, sessionId);
}

/**
 * Preload write/verify trap lenses for a review: read each target file's
 * current content (best-effort — an unreadable file contributes no lens
 * rather than failing the whole preload) and fold every distinct lens that
 * fires through the shared trap-library helper. Deterministic order: file
 * order (as given by {@link reviewTargetFilePaths}) × the helper's own
 * write-then-verify, entry-order dedup — the same ordering contract
 * `matchFileAgainstWriteVerifyTraps` documents, extended across files by
 * first-seen-wins.
 */
export function preloadedTrapLenses(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  workspaceRoot: string,
  target: ReviewTarget,
): readonly string[] {
  const seen = new Set<string>();
  const lenses: string[] = [];
  for (const path of reviewTargetFilePaths(runtime, sessionId, target)) {
    const text = readFileTextOrNull(workspaceRoot, path);
    if (text === null) {
      continue;
    }
    for (const match of matchFileAgainstWriteVerifyTraps(text)) {
      if (!seen.has(match.lens)) {
        seen.add(match.lens);
        lenses.push(match.lens);
      }
    }
  }
  return lenses;
}

/**
 * Merge caller-supplied lenses with trap-preloaded lenses, deduped by exact
 * text (a caller who already named a trap's lens verbatim must not see it
 * twice). Caller lenses keep their given order and precedence; trap lenses
 * ride in tail, in the order {@link preloadedTrapLenses} produced them.
 */
export function mergeLenses(
  callerLenses: readonly string[],
  trapLenses: readonly string[],
): readonly string[] {
  const merged = [...callerLenses];
  const seen = new Set(callerLenses);
  for (const lens of trapLenses) {
    if (!seen.has(lens)) {
      seen.add(lens);
      merged.push(lens);
    }
  }
  return merged;
}

/**
 * Digest a fixed path list into a `file_digests` targetRef, failing CLOSED on
 * any missing/unreadable file rather than snapshotting a partial, mask-prone
 * map. Shared by the `files` target and the atoms `file_digests` fallback so the
 * digest discipline is single-homed.
 */
function snapshotFileDigests(workspaceRoot: string, paths: readonly string[]): SnapshotResult {
  const digests: Record<string, string> = {};
  for (const path of paths) {
    const digest = readFileDigest(workspaceRoot, path);
    if (digest === null) {
      return {
        ok: false,
        message: `review_request: target file not found or unreadable: ${path}.`,
      };
    }
    digests[path] = digest;
  }
  return { ok: true, targetRef: { kind: "file_digests", digests } };
}

/**
 * Snapshot the target identity BEFORE dispatch.
 *
 * A `session_diff` target resolves to `patch_sets` (all applied sets) and
 * REQUIRES a non-empty applied set — reviewing "the diff" means reviewing what
 * patches applied.
 *
 * An `atoms` target snapshots `patch_sets` when applied sets exist, ELSE falls
 * back to `file_digests` over the session's fresh-touched-file universe — the
 * same touched files debt/fitness already track (Finding P2). A session that
 * finished via bare write/edit has no patch sets, but an atoms-level independent
 * review must still be possible so it can produce the `atomRefs` that close the
 * fitness loop. Only when there are NEITHER applied patch sets NOR any
 * fresh-touched files (nothing to review against) does it fail closed. The
 * packet objective enumerates the atom statements either way — only the snapshot
 * changes.
 *
 * A `files` target ALWAYS snapshots `file_digests` over its named paths — even
 * when the session has applied patch sets (Finding P1-B): a patch_sets ref would
 * dishonestly claim whole-change coverage for a review of a subset of files, and
 * that receipt would then clear session debt for unreviewed files.
 *
 * Every digest snapshot fails closed on any missing file, so every receipt's
 * targetRef honestly describes exactly what the reviewer read.
 */
export function snapshotTargetRef(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  workspaceRoot: string,
  target: ReviewTarget,
): SnapshotResult {
  if (target.kind === "session_diff") {
    const applied = sessionAppliedPatchSetIds(runtime, sessionId);
    if (applied.length === 0) {
      return {
        ok: false,
        message:
          "review_request: session_diff target has no applied patch sets to review. Apply a " +
          "patch set first, or pass an explicit files target.",
      };
    }
    return {
      ok: true,
      targetRef: { kind: "patch_sets", patchSetRefs: [...applied] },
    };
  }
  if (target.kind === "atoms") {
    const applied = sessionAppliedPatchSetIds(runtime, sessionId);
    if (applied.length > 0) {
      return {
        ok: true,
        targetRef: { kind: "patch_sets", patchSetRefs: [...applied] },
      };
    }
    // No applied patch sets: fall back to a file_digests snapshot over the
    // session's fresh-touched files (bare write/edit paths). Same digest
    // fail-closed discipline as a files target.
    const touched = sessionFreshTouchedFilePaths(runtime, sessionId, workspaceRoot);
    if (touched.length === 0) {
      return {
        ok: false,
        message:
          "review_request: atoms target has nothing to review — the session has no applied " +
          "patch sets and no fresh-touched files. Apply a patch or edit a file first, or pass " +
          "an explicit files target.",
      };
    }
    return snapshotFileDigests(workspaceRoot, touched);
  }
  if (target.paths.length === 0) {
    // Fail closed on a pathless files target rather than snapshotting a vacuous
    // empty-digests ref (which would read back as "nothing was reviewed" yet
    // still clear review debt). This mirrors the missing-file path: an
    // unreviewable target is an actionable error, not a silent empty snapshot.
    return {
      ok: false,
      message:
        "review_request: files target has no paths to review. Name at least one file, or " +
        "pass a session_diff target.",
    };
  }
  return snapshotFileDigests(workspaceRoot, target.paths);
}

/** One line per atom: id, modality, and statement, so the reviewer can quote which atom a finding bears on. */
function describeAtoms(atoms: readonly RequirementAtom[]): string {
  return atoms.map((atom) => `- [${atom.id}] (${atom.modality}) ${atom.statement}`).join("\n");
}

/**
 * The shared reviewer instruction for attesting requirement atoms and naming the
 * atom id in each finding's `atomRefs` — the seam that lets a FAIL mark the
 * SPECIFIC violated atom (so it leaves the debt set). Used verbatim both as an
 * `atoms` target's whole objective and as the appendix folded onto a covering
 * `files`/`session_diff` review, so the two can never phrase the ask differently.
 */
const ATOM_ATTESTATION_INSTRUCTION =
  "For each atom below, check whether its statement is genuinely satisfied by the code — not " +
  "just plausible-sounding, but actually true when you read the implementation. Report a finding " +
  "whenever an atom is NOT realized, and name the atom's id in that finding's atomRefs so it can " +
  "be traced back";

/** What the reviewer is told to read for a diff-shaped targetRef. */
function touchedFilesAnchor(targetRef: ReviewTargetRef): string {
  return targetRef.kind === "patch_sets" ? targetRef.patchSetRefs.join(", ") : "the current diff";
}

/** Anchor text for a targetRef, so the reviewer knows what to read without file contents in the packet. */
export function describeTargetForObjective(
  target: ReviewTarget,
  targetRef: ReviewTargetRef,
  atoms: readonly RequirementAtom[] = [],
): string {
  if (target.kind === "atoms") {
    return (
      "Verify that the implementation actually REALIZES each of these requirement atoms " +
      `against the session's touched files (${touchedFilesAnchor(targetRef)}). Read the touched ` +
      `files yourself. ${ATOM_ATTESTATION_INSTRUCTION}:\n\n${describeAtoms(atoms)}`
    );
  }
  const base =
    target.kind === "files"
      ? `Review these files (read them yourself):\n${target.paths.map((p) => `- ${p}`).join("\n")}`
      : `Review the change described by the session's applied patch sets: ${touchedFilesAnchor(
          targetRef,
        )}. Read the touched files yourself.`;
  // Coverage-scoped fold (review→atom attribution): when the dispatcher folded
  // outstanding debt atoms into this covering review, append the SAME attestation
  // ask an atoms target carries, so a FAIL finding can name the atom it violates.
  // A narrow review folds no atoms and keeps its base objective unchanged.
  if (atoms.length === 0) {
    return base;
  }
  return (
    `${base}\n\nAdditionally, confirm the implementation REALIZES each of these outstanding ` +
    `requirement atoms against the change you are reviewing. ${ATOM_ATTESTATION_INSTRUCTION}:` +
    `\n\n${describeAtoms(atoms)}`
  );
}

/**
 * Build the single-reviewer packet. The stance (plus appended lenses) becomes
 * the objective's framing; the consultBrief satisfies the review-consult
 * contract; contextBudget keeps the reviewer reading targets itself. modelHint
 * rides the packet into gateway routing.
 *
 * `lenses` is an explicit parameter (not read off `params.lenses`) so the
 * reviewer's objective text always matches whatever lens set the caller
 * decided to dispatch with — including the merged caller+trap-preloaded set
 * (Task 9), never silently falling back to the caller-only subset. `atoms` is
 * likewise explicit: only an `atoms` target's objective actually uses it, but
 * threading it through keeps this builder a pure function of everything the
 * objective depends on.
 */
export function buildReviewPacket(
  params: ReviewParams,
  targetRef: ReviewTargetRef,
  lenses: readonly string[],
  atoms: readonly RequirementAtom[] = [],
): DelegationPacket {
  const lensBlock =
    lenses.length > 0
      ? `\n\nAdditional lenses to hunt along:\n${lenses.map((lens) => `- ${lens}`).join("\n")}`
      : "";
  const objective = `${params.stance}${lensBlock}\n\n${describeTargetForObjective(
    params.target,
    targetRef,
    atoms,
  )}`;
  return {
    objective,
    deliverable:
      "A structured review outcome: a disposition (clear, concern, blocked, or inconclusive) " +
      "and one finding per issue with severity, category, and anchors.",
    consultBrief: {
      decision: "Is this change safe to ship, and what is wrong with it?",
      successCriteria:
        "Every real issue is reported as a finding with severity, category, and anchors; a " +
        "clean change is marked clear rather than padded with invented findings.",
    },
    contextBudget: { ...REVIEW_CONTEXT_BUDGET },
    ...(params.modelHint ? { modelHint: params.modelHint } : {}),
  };
}

/** Count parsed findings by severity, in canonical severity order. */
export function countBySeverity(findings: readonly DelegationOutcomeFinding[]): ReadonlyArray<{
  readonly severity: ReviewFindingSeverity;
  readonly count: number;
}> {
  return REVIEW_FINDING_SEVERITIES.map((severity) => ({
    severity,
    count: findings.filter(
      (finding) => normalizeReviewFindingSeverity(finding.severity) === severity,
    ).length,
  })).filter((entry) => entry.count > 0);
}

export interface ReviewResultTextInput {
  readonly outcome: "pass" | "fail" | "skipped";
  readonly disposition: ReviewLaneDisposition;
  readonly findings: readonly DelegationOutcomeFinding[];
  readonly targetRef: ReviewTargetRef;
}

/** Deterministic result summary: disposition, finding counts by severity, targetRef kind, receipts. */
export function buildReviewResultText(input: ReviewResultTextInput): string {
  const severityParts = countBySeverity(input.findings).map(
    (entry) => `${entry.count} ${entry.severity}`,
  );
  const severitySuffix = severityParts.length > 0 ? ` (${severityParts.join(", ")})` : "";
  const findingCount = input.findings.length;
  const findingNoun = findingCount === 1 ? "finding" : "findings";
  return (
    `independent review: ${input.outcome} — ${findingCount} ${findingNoun}${severitySuffix} ` +
    `on ${input.targetRef.kind} snapshot; receipts recorded ` +
    `(${findingCount} ${findingNoun}, 1 independent outcome).`
  );
}
