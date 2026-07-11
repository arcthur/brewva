import { isRecord } from "@brewva/brewva-std/unknown";
import { payloadOf } from "./events.js";
import type { WriteInvocationPath } from "./tool-invocations.js";
import type { ProtocolRecord } from "./types/foundation.js";

/**
 * Who performed the verification: the same reasoning stream that authored the
 * change ("authored"), or a stream deliberately separated from authorship by
 * one of the `IndependenceBasis` arms ("independent"). This is the perspective
 * dimension the intent-realization loop scores independently from outcome —
 * a pass proves nothing about independence and vice versa.
 */
export const VERIFICATION_PERSPECTIVES = ["authored", "independent"] as const;

export type VerificationPerspective = (typeof VERIFICATION_PERSPECTIVES)[number];

/**
 * How a receipt earned the "independent" perspective. Multiple bases can
 * apply to one receipt (e.g. a different model AND a fresh context).
 */
export const INDEPENDENCE_BASES = [
  "fresh_context",
  "different_model",
  "preloaded_lens",
  "human",
  "deterministic_adapter",
] as const;

export type IndependenceBasis = (typeof INDEPENDENCE_BASES)[number];

/** Identity of the reviewing stream, when one produced the receipt. */
export interface ReviewerContext {
  readonly model: string | null;
  readonly contextId: string | null;
  readonly lenses: readonly string[];
}

/**
 * What a verification or finding receipt says it reviewed, as a snapshot
 * identity rather than a live pointer — staleness is checked later against
 * the current tree via `reviewTargetRefMatchesTree`. Only the two arms that
 * get producers in this wave ship here; the RFC also names a `diff_digest`
 * form, deliberately deferred (producer-wiring invariant).
 */
export type ReviewTargetRef =
  | { readonly kind: "patch_sets"; readonly patchSetRefs: readonly string[] }
  | {
      readonly kind: "file_digests";
      readonly digests: Readonly<Record<string, string>>;
    };

/**
 * Defensive parse of a `ReviewTargetRef`; invalid or unknown `kind` -> null.
 * Exported (not just internal) so `internal/iteration.ts`'s outcome reader
 * can reuse it for `VerificationOutcomeRecordedEventPayload.targetRef` — one
 * parser, shared across both receipt kinds that carry a target ref.
 */
export function readReviewTargetRef(value: unknown): ReviewTargetRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const record = value as ProtocolRecord;
  if (record.kind === "patch_sets") {
    if (!Array.isArray(record.patchSetRefs)) {
      return null;
    }
    const patchSetRefs = record.patchSetRefs.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return { kind: "patch_sets", patchSetRefs };
  }
  if (record.kind === "file_digests") {
    // Deliberate asymmetry vs. patch_sets above: a partial digest map could mask an unchecked path, so any non-string digest rejects the WHOLE ref instead of being filtered out.
    if (
      typeof record.digests !== "object" ||
      record.digests === null ||
      Array.isArray(record.digests)
    ) {
      return null;
    }
    const digestEntries = Object.entries(record.digests as ProtocolRecord).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (digestEntries.length !== Object.keys(record.digests as ProtocolRecord).length) {
      return null;
    }
    return { kind: "file_digests", digests: Object.fromEntries(digestEntries) };
  }
  return null;
}

/**
 * Review finding severity, shared across the review ensemble and the
 * intent-realization loop. Reuses the exact value set already established by
 * `DelegationOutcomeFinding.severity` in `packages/brewva-tools/src/contracts/
 * delegation.ts` — that field has no standalone exported type to import
 * (it is inline on an unrelated, broader delegation-outcome shape), so this
 * is a fresh named export, not an extraction.
 */
export const REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;

export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

/**
 * Review finding category. No prior vocabulary exists for this dimension:
 * `ReviewChangeCategory` in `packages/brewva-tools/src/shared/review-
 * classification.ts` classifies the RISK SURFACE a code change touches
 * (authn, wire_protocol, ...), not what KIND of problem a finding reports, so
 * it is not a fit and is left untouched.
 *
 * The KIND-of-problem dimensions mirror the review-ensemble lane names
 * (correctness / security / performance / concurrency / compatibility /
 * operability — see `shared/review-ensemble/index.ts`) plus the softer
 * style / test_coverage / documentation kinds. `unknown` is an explicit,
 * honest sink for a reviewer-declared category that is omitted or outside this
 * vocabulary: mapping such a finding to `correctness` (the prior default) would
 * mislabel architecture/concurrency/etc. findings and pollute downstream
 * category analytics, so unknowns are named as unknown, never disguised.
 */
export const REVIEW_FINDING_CATEGORIES = [
  "correctness",
  "security",
  "performance",
  "concurrency",
  "compatibility",
  "operability",
  "style",
  "test_coverage",
  "documentation",
  "unknown",
] as const;

export type ReviewFindingCategory = (typeof REVIEW_FINDING_CATEGORIES)[number];

export const REVIEW_FINDING_RECORDED_EVENT_TYPE = "review.finding.recorded" as const;

/**
 * A review finding as a tape receipt: independent evidence that a reviewing
 * stream inspected `targetRef` and reports `statement`. `atomRefs` links the
 * finding to the requirement atoms it bears on (see `internal/task.ts`).
 */
export interface ReviewFindingRecordedEventPayload extends ProtocolRecord {
  readonly findingId: string;
  readonly severity: ReviewFindingSeverity;
  readonly category: ReviewFindingCategory;
  readonly statement: string;
  readonly anchors: readonly string[];
  readonly lens: string | null;
  readonly targetRef: ReviewTargetRef;
  readonly atomRefs: readonly string[];
}

/**
 * `targetRef` is mandatory on this kind: a finding cannot say what tree state
 * it reviewed and still count as evidence. So unlike the outcome reader
 * (which defaults `targetRef` to null field-by-field), an unparsable
 * `targetRef` here fails the WHOLE payload to null.
 */
export const readReviewFindingRecordedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): ReviewFindingRecordedEventPayload | null => {
  const payload = payloadOf(event);
  const targetRef = readReviewTargetRef(payload.targetRef);
  if (targetRef === null) {
    return null;
  }
  const severity = (
    (REVIEW_FINDING_SEVERITIES as readonly unknown[]).includes(payload.severity)
      ? payload.severity
      : "low"
  ) as ReviewFindingSeverity;
  const category = (
    (REVIEW_FINDING_CATEGORIES as readonly unknown[]).includes(payload.category)
      ? payload.category
      : "unknown"
  ) as ReviewFindingCategory;
  return {
    findingId: typeof payload.findingId === "string" ? payload.findingId : "",
    severity,
    category,
    statement: typeof payload.statement === "string" ? payload.statement : "",
    anchors: Array.isArray(payload.anchors)
      ? payload.anchors.filter((entry): entry is string => typeof entry === "string")
      : [],
    lens: typeof payload.lens === "string" ? payload.lens : null,
    targetRef,
    atomRefs: Array.isArray(payload.atomRefs)
      ? payload.atomRefs.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
};

/**
 * Pure staleness check: does a recorded `ReviewTargetRef` still describe the
 * current tree? `patch_sets` is set-equality (order-insensitive) against the
 * currently applied patches — any drift, in either direction, is stale, since
 * the recorded ref no longer describes exactly what the reviewer saw.
 * `file_digests` requires every recorded path's current digest to match; a
 * path the tree no longer has is stale by definition.
 */
export function reviewTargetRefMatchesTree(
  ref: ReviewTargetRef,
  tree: {
    readonly appliedPatchSetRefs: readonly string[];
    readonly fileDigest: (path: string) => string | null;
  },
): boolean {
  if (ref.kind === "patch_sets") {
    if (ref.patchSetRefs.length !== tree.appliedPatchSetRefs.length) {
      return false;
    }
    const applied = new Set(tree.appliedPatchSetRefs);
    return ref.patchSetRefs.every((patchSetRef) => applied.has(patchSetRef));
  }
  return Object.entries(ref.digests).every(([path, digest]) => tree.fileDigest(path) === digest);
}

/**
 * Conservative, tape-only variant of {@link reviewTargetRefMatchesTree} for
 * read-side projections (Work Card evidence, run-report) that MUST NOT read
 * the filesystem — a projection is rebuilt from receipts alone (axiom 18).
 * `patch_sets` keeps the same set-equality rule (it was already tape-only:
 * `appliedPatchSetRefs` derives from `deriveAppliedPatchSetIds` over the tape).
 * `file_digests` can not diff a real digest without reading the file, so this
 * variant asks a weaker, honest question instead: has the working tree been
 * mutated on the tape after the receipt's own timestamp? If not, nothing could
 * have changed since the reviewer looked, so the ref still describes the tree.
 * If a tree mutation *has* landed since, the ref is treated as stale even when
 * that mutation happened to leave the reviewed files untouched — this rule
 * under-claims freshness at worst (debt shows although the tree still matches),
 * never over-claims it, matching the brief's explicit direction for both W1
 * read surfaces that share this rule (Work Card evidence and run-report
 * verification). A tree mutation is any successful patch application, rollback,
 * OR bare write/edit invocation (Finding P1) — each rewrites files, so all must
 * advance `latestTreeMutationAt` or a post-review mutation would be silently
 * treated as leaving the ref fresh (an over-claim). The caller derives that
 * timestamp through the single shared fold `deriveLatestTreeMutationAt`.
 */
export function reviewTargetRefMatchesTapeOnly(
  ref: ReviewTargetRef,
  tape: {
    readonly appliedPatchSetRefs: readonly string[];
    readonly receiptTimestamp: number;
    readonly latestTreeMutationAt: number | null;
  },
): boolean {
  if (ref.kind === "patch_sets") {
    if (ref.patchSetRefs.length !== tape.appliedPatchSetRefs.length) {
      return false;
    }
    const applied = new Set(tape.appliedPatchSetRefs);
    return ref.patchSetRefs.every((patchSetRef) => applied.has(patchSetRef));
  }
  return tape.latestTreeMutationAt === null || tape.latestTreeMutationAt <= tape.receiptTimestamp;
}

/**
 * Normalize a workspace path for set membership: forward slashes, no leading
 * `./`, no trailing slash. When the path is absolute and an invocation `cwd` is
 * supplied, it is made cwd-relative so an absolute write target (e.g. an
 * `edit`'s `/repo/src/a.ts`) matches a workspace-relative attested path (a
 * `file_digests` key or a patch's `appliedPaths`, both workspace-relative).
 * Absolute paths outside the cwd stay absolute (and correctly never match a
 * workspace-relative attested set). Mirrors the path handling already used by
 * the gateway skill-adoption projection so the two normalizers agree.
 */
export function normalizeReviewPath(path: string, cwd: string | null = null): string {
  let value = path.replaceAll("\\", "/").trim();
  if (value.startsWith("brewva-resource:///file/")) {
    value = decodeUriComponentSafe(value.slice("brewva-resource:///file/".length));
  } else if (value.startsWith("file://")) {
    value = decodeUriComponentSafe(value.slice("file://".length));
  }
  if (cwd && value.startsWith("/")) {
    const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
    if (normalizedCwd.length > 0 && value.startsWith(`${normalizedCwd}/`)) {
      value = value.slice(normalizedCwd.length + 1);
    }
  }
  return value.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function decodeUriComponentSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The set of file paths a session wrote this turn, plus whether that set is
 * fully knowable from the tape. Used to decide whether an independent receipt
 * COVERS the change (Finding P1-C): a subset review of `a.ts` must not clear
 * debt when `b.ts` was also touched and left unreviewed.
 *
 * `fullyKnown` is false when at least one write-class invocation's target path
 * could not be parsed from its recorded args. A not-fully-known universe can
 * never be proven covered, so coverage fails closed (debt shows) rather than
 * risk a false clear — see {@link universeCoveredBy}. This is a superset-leaning
 * approximation on purpose: rollback path-removal is NOT modeled (a
 * patched-then-rolled-back file stays in the universe), which can only make
 * coverage HARDER (show debt when arguably none), never falsely clear.
 */
export interface FreshTouchedFileUniverse {
  readonly files: ReadonlySet<string>;
  readonly fullyKnown: boolean;
}

/**
 * Derive the fresh-touched-file universe from tape-derived signals the
 * effectful shell has already extracted: the union of `source_patch_applied`
 * `appliedPaths` and the target path of every write-class tool invocation
 * (write/edit). `source_patch_apply`'s own paths arrive via `appliedPaths`
 * (its applied receipt is the source of truth), so it is NOT double-counted as
 * a write-invocation path.
 *
 * A `null` write path (unparseable args) sets `fullyKnown=false` — the session
 * wrote a file we cannot name, so coverage of the universe cannot be proven.
 * Lives here so both debt inputs (live `assembleReviewDebtInput`, tape
 * `buildTapeReviewDebt`) derive the universe through ONE definition.
 */
export function deriveFreshTouchedFileUniverse(input: {
  readonly appliedPaths: readonly string[];
  readonly writeInvocationPaths: readonly WriteInvocationPath[];
}): FreshTouchedFileUniverse {
  const files = new Set<string>();
  let fullyKnown = true;
  for (const applied of input.appliedPaths) {
    const normalized = normalizeReviewPath(applied);
    if (normalized.length > 0) {
      files.add(normalized);
    }
  }
  for (const write of input.writeInvocationPaths) {
    if (write.path === null) {
      fullyKnown = false;
      continue;
    }
    const normalized = normalizeReviewPath(write.path, write.cwd);
    if (normalized.length > 0) {
      files.add(normalized);
    }
  }
  return { files, fullyKnown };
}

/**
 * The set of files an independent receipt attests to reviewing, normalized for
 * comparison against the universe. `file_digests` attests exactly its digested
 * paths; `patch_sets` attests the union of `appliedPaths` for the
 * `source_patch_applied` events whose `patchSetId` is in the ref (looked up via
 * `appliedPathsForPatchSet`, supplied by the caller's tape scan). A
 * `session_diff` review's ref is all applied sets, so it attests every
 * patch-applied file — and if the session ALSO wrote files outside any patch
 * set, coverage correctly fails (those files are in the universe but not
 * attested), which is honest.
 */
export function attestedFilesForRef(
  ref: ReviewTargetRef,
  appliedPathsForPatchSet: (patchSetId: string) => readonly string[],
): ReadonlySet<string> {
  const attested = new Set<string>();
  if (ref.kind === "file_digests") {
    for (const path of Object.keys(ref.digests)) {
      const normalized = normalizeReviewPath(path);
      if (normalized.length > 0) {
        attested.add(normalized);
      }
    }
    return attested;
  }
  for (const patchSetId of ref.patchSetRefs) {
    for (const path of appliedPathsForPatchSet(patchSetId)) {
      const normalized = normalizeReviewPath(path);
      if (normalized.length > 0) {
        attested.add(normalized);
      }
    }
  }
  return attested;
}

/**
 * Does an attested-file set COVER the fresh-touched universe? True iff the
 * universe is fully known AND every universe file is attested (attested ⊇
 * universe). A not-fully-known universe is never covered (fail closed). An
 * empty, fully-known universe is trivially covered — if the tape proves no
 * file-scoped write happened, there is nothing to under-cover.
 */
export function universeCoveredBy(
  attested: ReadonlySet<string>,
  universe: FreshTouchedFileUniverse,
): boolean {
  if (!universe.fullyKnown) {
    return false;
  }
  for (const file of universe.files) {
    if (!attested.has(file)) {
      return false;
    }
  }
  return true;
}

/**
 * Verification depth rungs, weakest to strongest. Each rung subsumes the ones
 * below it; `level` on the outcome receipt carries the reached rung so read
 * models can score verification depth instead of treating it as a boolean.
 *
 * Lives here (not `internal/iteration.ts`) because rung-ranking is what
 * `projectReviewDebt` below needs, and `iteration.ts` already imports several
 * review-domain types from this module — defining the rungs there and
 * importing them back here would be a circular internal-module dependency.
 * `internal/iteration.ts` re-exports this constant so its public import path
 * (`@brewva/brewva-vocabulary/iteration`) is unchanged for existing callers.
 */
export const VERIFICATION_RUNGS = [
  "exit_code",
  "diagnostics",
  "artifact",
  "requirements",
  "runtime_smoke",
] as const;

export type VerificationRung = (typeof VERIFICATION_RUNGS)[number];

const REVIEW_DEBT_MINIMUM_RUNG_INDEX = VERIFICATION_RUNGS.indexOf("requirements");

/** Inputs the review-debt projection needs, already assembled by the caller's effectful shell. */
export interface ReviewDebtInput {
  readonly freshCodeWritten: boolean;
  readonly claim: {
    readonly outcome: "pass" | "fail" | "skipped";
    readonly level: string | null;
  };
  readonly independentReceipts: ReadonlyArray<{
    readonly targetRef: ReviewTargetRef | null;
  }>;
  readonly matchesTree: (ref: ReviewTargetRef) => boolean;
  /**
   * The fresh-touched-file universe this session wrote (Finding P1-C). Carried
   * so the projection can distinguish a receipt that COVERS the change from one
   * that only touches part of it.
   */
  readonly freshTouchedUniverse: FreshTouchedFileUniverse;
  /**
   * Does this receipt's targetRef cover the fresh-touched universe? The shell
   * builds this from {@link attestedFilesForRef} + {@link universeCoveredBy};
   * kept as a closure (mirroring `matchesTree`) so the pure core stays free of
   * the tape/patch-set lookup the coverage set needs.
   */
  readonly covers: (ref: ReviewTargetRef) => boolean;
}

export interface ReviewDebt {
  readonly debt: boolean;
  readonly reason: "no_independent_receipt" | "independent_receipts_stale" | null;
}

/**
 * Pure W1 producer projection: does the claim being recorded right now leave
 * review debt behind? Debt fires only when fresh code was written this
 * session, the claim itself is a `pass` at `requirements` rung or above, and
 * no `independent`-perspective receipt has a `targetRef` matching the current
 * tree. This judges the CLAIM BEING MADE, not any prior receipt on the tape —
 * a caller must pass the in-flight claim as `input.claim`, not the tape's
 * previous latest.
 *
 * Debt clears only when SOME independent receipt BOTH matches the current tree
 * AND covers the fresh-touched-file universe (Finding P1-C): an honest
 * `file_digests{a.ts}` must not clear debt when `b.ts` was also touched and
 * left unreviewed. A receipt that matches-but-does-not-cover, or
 * covers-but-is-stale, "exists but does not clear".
 *
 * `no_independent_receipt` (none exist at all) is distinguished from
 * `independent_receipts_stale` (some exist, but none both match and cover) so
 * the marker can name what is actually missing.
 */
export function projectReviewDebt(input: ReviewDebtInput): ReviewDebt {
  if (!input.freshCodeWritten || input.claim.outcome !== "pass" || input.claim.level === null) {
    return { debt: false, reason: null };
  }
  const rungIndex = VERIFICATION_RUNGS.indexOf(input.claim.level as VerificationRung);
  if (rungIndex < REVIEW_DEBT_MINIMUM_RUNG_INDEX) {
    return { debt: false, reason: null };
  }
  const cleared = input.independentReceipts.some(
    (receipt) =>
      receipt.targetRef !== null &&
      input.matchesTree(receipt.targetRef) &&
      input.covers(receipt.targetRef),
  );
  if (cleared) {
    return { debt: false, reason: null };
  }
  return {
    debt: true,
    reason:
      input.independentReceipts.length === 0
        ? "no_independent_receipt"
        : "independent_receipts_stale",
  };
}

/** One parsed `verification.outcome.recorded` receipt, as read off the tape by the caller. */
export interface TapeVerificationReceipt {
  readonly timestamp: number;
  readonly outcome: "pass" | "fail" | "skipped" | null;
  readonly level: string | null;
  readonly perspective: VerificationPerspective;
  readonly targetRef: ReviewTargetRef | null;
}

/** Inputs {@link projectTapeReviewDebt} needs — every field is tape-derived, no filesystem access. */
export interface TapeReviewDebtInput {
  readonly freshCodeWritten: boolean;
  /** Every `verification.outcome.recorded` receipt on the tape, any perspective, tape order. */
  readonly receipts: readonly TapeVerificationReceipt[];
  readonly appliedPatchSetRefs: readonly string[];
  /**
   * Latest timestamp among tape tree-mutating events — a successful
   * `source_patch_applied`/`rollback.recorded`, OR a bare write/edit invocation
   * (Finding P1) — or null if none. All three mutate the tree, so all count; the
   * caller derives this via the shared `deriveLatestTreeMutationAt` fold. See
   * {@link reviewTargetRefMatchesTapeOnly}.
   */
  readonly latestTreeMutationAt: number | null;
  /**
   * The fresh-touched-file universe (Finding P1-C), tape-derived by the caller
   * via {@link deriveFreshTouchedFileUniverse}. Debt clears only when a matching
   * independent receipt also covers this universe.
   */
  readonly freshTouchedUniverse: FreshTouchedFileUniverse;
  /**
   * `appliedPaths` per applied patch-set id, tape-derived — used to compute the
   * attested files of a `patch_sets` receipt (Finding P1-C). A patch-set id not
   * present here contributes no attested files.
   */
  readonly patchSetAppliedPaths: Readonly<Record<string, readonly string[]>>;
}

/**
 * THE single review-debt read for tape-only surfaces: Work Card evidence and
 * run-report verification both call this — not `projectReviewDebt` directly —
 * so the conservative match rule ({@link reviewTargetRefMatchesTapeOnly}) and
 * the "which receipt is the claim" choice live in exactly one place instead of
 * being re-derived twice and drifting.
 *
 * The claim judged is the tape's LATEST `verification.outcome.recorded`
 * receipt (any perspective) — a replay's analogue of "the pass being recorded
 * right now" that {@link projectReviewDebt} expects from its live producer
 * caller. When the tape holds no receipt at all, there is no claim to owe debt
 * against.
 *
 * Finding P1-A: each independent receipt's freshness is judged against ITS OWN
 * timestamp, not the latest claim's. Passing the claim's timestamp for every
 * receipt (the prior bug) would judge a `file_digests` receipt reviewed at t1
 * fresh against a claim at t3 even though the tree mutated at t2 (t1 < t2 < t3)
 * — stale evidence wrongly clearing debt. The per-receipt closures below carry
 * each receipt's timestamp and attested-file set, keyed by ref identity.
 */
export function projectTapeReviewDebt(input: TapeReviewDebtInput): ReviewDebt {
  const latest = input.receipts.at(-1);
  if (!latest) {
    return { debt: false, reason: null };
  }
  const independent = input.receipts.filter((receipt) => receipt.perspective === "independent");
  // Ref-identity -> the receipt's OWN timestamp (P1-A). A receipt with a null
  // ref is dropped by projectReviewDebt's own null guard, so it never needs a
  // timestamp entry.
  const receiptTimestampByRef = new Map<ReviewTargetRef, number>();
  for (const receipt of independent) {
    if (receipt.targetRef !== null) {
      receiptTimestampByRef.set(receipt.targetRef, receipt.timestamp);
    }
  }
  const appliedPathsForPatchSet = (patchSetId: string): readonly string[] =>
    input.patchSetAppliedPaths[patchSetId] ?? [];
  return projectReviewDebt({
    freshCodeWritten: input.freshCodeWritten,
    claim: { outcome: latest.outcome ?? "skipped", level: latest.level },
    independentReceipts: independent.map((receipt) => ({ targetRef: receipt.targetRef })),
    matchesTree: (ref) =>
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: input.appliedPatchSetRefs,
        // The receipt's OWN timestamp; fall back to the claim only if this ref
        // is somehow unmapped (it always maps for a non-null ref).
        receiptTimestamp: receiptTimestampByRef.get(ref) ?? latest.timestamp,
        latestTreeMutationAt: input.latestTreeMutationAt,
      }),
    freshTouchedUniverse: input.freshTouchedUniverse,
    covers: (ref) =>
      universeCoveredBy(
        attestedFilesForRef(ref, appliedPathsForPatchSet),
        input.freshTouchedUniverse,
      ),
  });
}

/**
 * One review finding paired with its OWN receipt timestamp — the per-finding
 * freshness key (Finding P1-A): a finding recorded at t1 is judged fresh against
 * the tree as of t1, never against a later render time, so a tree mutation at t2
 * correctly ages it out even when the render happens at t3.
 */
export interface TapeReviewFinding {
  readonly finding: ReviewFindingRecordedEventPayload;
  readonly receiptTimestamp: number;
}

/** One review finding still live (unaddressed) at render time. */
export interface UnaddressedReviewFinding {
  readonly findingId: string;
  readonly severity: ReviewFindingSeverity;
  readonly statement: string;
  /** Atoms the finding names; empty when the reviewer left it unattributed. */
  readonly atomRefs: readonly string[];
}

export interface UnaddressedReviewFindingsInput {
  readonly findings: readonly TapeReviewFinding[];
  /**
   * Normalized workspace-relative path → the LATEST tape timestamp at which that
   * file was mutated (a bare write/edit commitment or an applied patch touching it).
   * The caller builds this from the tape (relativizing absolute write args against
   * the workspace root so the keys match anchor paths). This is what makes freshness
   * ANCHOR-scoped rather than whole-tree: a finding is addressed only when a file IT
   * flagged changed, not when any unrelated file did.
   */
  readonly fileMutationTimeline: ReadonlyMap<string, number>;
  /** Fallback (anchorless findings only): the coarse whole-tree tape-only inputs. */
  readonly appliedPatchSetRefs: readonly string[];
  readonly latestTreeMutationAt: number | null;
}

/**
 * The workspace-relative file path an anchor points at, or null when the anchor
 * carries no parseable path. Anchors are `path:line`, `path:start-end`, or
 * `path:line:col` (e.g. `Sources/VoiceBar/FnKeyMonitor.swift:50-53`) or a bare
 * path; the trailing line/col span is stripped and the path normalized to the same
 * convention the mutation timeline keys use. An empty/whitespace anchor yields null.
 * A descriptor anchor with no file shape still returns its normalized text (it
 * simply never matches a timeline key, so its finding conservatively stays live —
 * the safe direction for an advisory).
 */
export function reviewAnchorFilePath(anchor: string): string | null {
  const withoutLineSpan = anchor.replace(/:\d+(?:[:-]\d+)?$/u, "");
  const normalized = normalizeReviewPath(withoutLineSpan);
  return normalized.length > 0 ? normalized : null;
}

/**
 * The act-on-review closure signal: which recorded review findings remain LIVE —
 * the flagged code was not changed since the finding, so the review's ask is still
 * open. The complement of {@link projectTapeReviewDebt} (which asks "was a review
 * OWED"): this asks "did a review that HAPPENED get acted on."
 */
export interface UnaddressedReviewFindings {
  /** Live findings, in input (tape) order — the flagged code is untouched since each. */
  readonly findings: readonly UnaddressedReviewFinding[];
  /** Count per severity over {@link findings}. */
  readonly countBySeverity: Readonly<Record<ReviewFindingSeverity, number>>;
  /** Union of atom ids the live findings name (the attributed subset). */
  readonly atomRefs: readonly string[];
  /**
   * How many live findings name NO atom — the attribution gap that makes them
   * INVISIBLE to the fitness projection's `discrepancies` (which key on ledger
   * atoms), so reading findings directly is the only way to surface them.
   */
  readonly unattributedCount: number;
}

/**
 * Project the unaddressed (still-live) review findings from the tape's recorded
 * findings. A finding is ADDRESSED — and dropped — when the code IT flagged was
 * touched since it was recorded: any file named in the finding's `anchors` whose
 * latest mutation timestamp is AFTER the finding's own timestamp (Finding P1-A).
 *
 * ANCHOR-scoped, deliberately NOT whole-`targetRef`-scoped: a review commonly
 * records a whole-repo `file_digests` snapshot, so a whole-tree freshness rule
 * would age EVERY finding out the moment the model touches ANY file — letting a
 * defect ship by editing something unrelated (observed: game_8's `req-1` keycode
 * finding cleared when the model edited `Package.swift`, though `FnKeyMonitor.swift`
 * was never fixed). Scoping to the anchored files fixes that: the `req-1` finding
 * stays live because its anchor file was not touched.
 *
 * A finding with NO parseable anchor path falls back to the coarse whole-tree
 * {@link reviewTargetRefMatchesTapeOnly} rule (the only signal available without a
 * file to scope to). Reads findings DIRECTLY (not via fitness `discrepancies`), so
 * an unattributed finding (`atomRefs: []`) — invisible to the atom-keyed projection
 * — is still counted. Pure: no filesystem, no clock; the caller supplies the
 * tape-derived {@link UnaddressedReviewFindingsInput.fileMutationTimeline}.
 */
export function projectUnaddressedReviewFindings(
  input: UnaddressedReviewFindingsInput,
): UnaddressedReviewFindings {
  const findings: UnaddressedReviewFinding[] = [];
  const countBySeverity: Record<ReviewFindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const atomRefs = new Set<string>();
  let unattributedCount = 0;
  for (const { finding, receiptTimestamp } of input.findings) {
    const anchorFiles = new Set<string>();
    for (const anchor of finding.anchors) {
      const path = reviewAnchorFilePath(anchor);
      if (path !== null) {
        anchorFiles.add(path);
      }
    }
    let fresh: boolean;
    if (anchorFiles.size > 0) {
      // ADDRESSED iff an anchored file was mutated AFTER this finding.
      fresh = ![...anchorFiles].some(
        (path) => (input.fileMutationTimeline.get(path) ?? 0) > receiptTimestamp,
      );
    } else {
      // No file to scope to — fall back to the coarse whole-tree rule.
      fresh = reviewTargetRefMatchesTapeOnly(finding.targetRef, {
        appliedPatchSetRefs: input.appliedPatchSetRefs,
        receiptTimestamp,
        latestTreeMutationAt: input.latestTreeMutationAt,
      });
    }
    if (!fresh) {
      continue;
    }
    findings.push({
      findingId: finding.findingId,
      severity: finding.severity,
      statement: finding.statement,
      atomRefs: finding.atomRefs,
    });
    countBySeverity[finding.severity] += 1;
    if (finding.atomRefs.length === 0) {
      unattributedCount += 1;
    } else {
      for (const atomId of finding.atomRefs) {
        atomRefs.add(atomId);
      }
    }
  }
  return { findings, countBySeverity, atomRefs: [...atomRefs], unattributedCount };
}
