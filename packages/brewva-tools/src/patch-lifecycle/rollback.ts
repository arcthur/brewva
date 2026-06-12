import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { resolveSessionPatchHistoryDirectory } from "@brewva/brewva-vocabulary/workbench";

/**
 * Patch lifecycle rollback over tracked mutation material.
 *
 * This module is the single reader of the rollback manifests written by
 * `source_patch_apply` (`<patchHistory>/<sessionId>/<patchSetId>/rollback.json`
 * plus `before/` content captures). Every surface that offers patch rollback
 * (the default hosted runtime capability and the `rollback_last_patch` tool
 * riding on it) goes through this lifecycle: one candidate discovery, one
 * artifact validation, one restore procedure, one set of explicit failure
 * states. Session rewind remains a separate lineage primitive and does not
 * pass through here. Rollback is recovery over known tracked mutations,
 * never generic undo.
 *
 * The manifest is on-disk state, not tape, so it is treated as untrusted
 * input: a strict schema is enforced, every path must resolve inside the
 * workspace root (no absolute paths, no `..`, symlink escapes rejected via
 * realpath), artifact refs must live inside the manifest's own patch-set
 * directory, and any violation rejects the whole manifest as
 * `rollback_artifact_invalid` instead of silently dropping entries.
 */

const ROLLBACK_MANIFEST_FILE = "rollback.json";
const ROLLBACK_MANIFEST_VERSION = 1;

export type RollbackMutationOperation = "write" | "delete" | "rename";

export interface RollbackManifestEntry {
  /** Workspace-relative path of the mutated file. */
  readonly path: string;
  readonly operation: RollbackMutationOperation;
  readonly oldPath?: string;
  readonly newPath?: string;
  /** `sha256:<hex>` of the pre-mutation content, absent for created files. */
  readonly beforeHash?: string;
  /** `sha256:<hex>` of the post-mutation content, absent for deletes/renames. */
  readonly afterHash?: string;
  /** Workspace-relative path of the captured pre-mutation content. */
  readonly beforeArtifactRef?: string;
}

export interface RollbackManifest {
  readonly version: number;
  readonly patchSetId: string;
  readonly createdAt: number;
  readonly entries: readonly RollbackManifestEntry[];
}

export interface PatchRollbackCandidate {
  readonly patchSetId: string;
  readonly manifestPath: string;
  readonly manifest: RollbackManifest;
  readonly affectedPaths: readonly string[];
}

export type RollbackNoCandidateReason =
  | "no_patchset"
  | "rollback_artifact_missing"
  | "rollback_artifact_invalid";

export type RollbackCandidateResolution =
  | { readonly kind: "candidate"; readonly candidate: PatchRollbackCandidate }
  | { readonly kind: "none"; readonly reason: RollbackNoCandidateReason };

export interface PatchRollbackExecution {
  readonly ok: boolean;
  readonly patchSetId: string;
  readonly restoredPaths: string[];
  readonly failedPaths: string[];
  readonly reason?:
    | "rollback_artifact_missing"
    | "rollback_artifact_invalid"
    | "conflict"
    | "partial_failure";
}

export interface AppliedPatchSetRef {
  readonly patchSetId: string;
  /** Workspace-relative manifest path recorded on the apply receipt. */
  readonly rollbackArtifactRef?: string;
}

function contentHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

function hasTraversalSegments(path: string): boolean {
  return path.split(/[\\/]/u).some((segment) => segment === ".." || segment === "." || !segment);
}

/**
 * Resolve a manifest-supplied relative path strictly inside `root`. Rejects
 * absolute paths and traversal segments lexically, then defends against
 * symlink escapes by realpath-resolving the deepest existing ancestor.
 */
function resolveContainedPath(root: string, path: string): string | null {
  if (isAbsolute(path) || hasTraversalSegments(path)) {
    return null;
  }
  const absolute = resolve(root, path);
  const realRoot = realpathSync(root);
  let probe = absolute;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) {
      return null;
    }
    probe = parent;
  }
  const relReal = relative(realRoot, realpathSync(probe));
  if (relReal.startsWith(`..${sep}`) || relReal === ".." || isAbsolute(relReal)) {
    return null;
  }
  return absolute;
}

function readOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function readManifestEntry(value: unknown): RollbackManifestEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.path !== "string" ||
    (candidate.operation !== "write" &&
      candidate.operation !== "delete" &&
      candidate.operation !== "rename")
  ) {
    return null;
  }
  const oldPath = readOptionalString(candidate.oldPath);
  const newPath = readOptionalString(candidate.newPath);
  const beforeHash = readOptionalString(candidate.beforeHash);
  const afterHash = readOptionalString(candidate.afterHash);
  const beforeArtifactRef = readOptionalString(candidate.beforeArtifactRef);
  if (
    oldPath === null ||
    newPath === null ||
    beforeHash === null ||
    afterHash === null ||
    beforeArtifactRef === null
  ) {
    return null;
  }
  return {
    path: candidate.path,
    operation: candidate.operation,
    ...(oldPath !== undefined ? { oldPath } : {}),
    ...(newPath !== undefined ? { newPath } : {}),
    ...(beforeHash !== undefined ? { beforeHash } : {}),
    ...(afterHash !== undefined ? { afterHash } : {}),
    ...(beforeArtifactRef !== undefined ? { beforeArtifactRef } : {}),
  };
}

interface ValidatedManifest {
  readonly manifest: RollbackManifest;
  readonly reason?: undefined;
}

interface InvalidManifest {
  readonly manifest?: undefined;
  readonly reason: "rollback_artifact_missing" | "rollback_artifact_invalid";
}

/**
 * Strict manifest intake: schema, version, patch-set identity, and path
 * containment are all validated up front. One invalid entry rejects the
 * whole manifest — silently dropping entries and "succeeding" on the rest
 * would fabricate a recovery that never matched the recorded mutation set.
 */
function readValidatedManifest(input: {
  readonly workspaceRoot: string;
  readonly manifestPath: string;
  readonly expectedPatchSetId: string;
}): ValidatedManifest | InvalidManifest {
  if (!existsSync(input.manifestPath)) {
    return { reason: "rollback_artifact_missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(input.manifestPath, "utf8"));
  } catch {
    return { reason: "rollback_artifact_invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "rollback_artifact_invalid" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== ROLLBACK_MANIFEST_VERSION ||
    candidate.patchSetId !== input.expectedPatchSetId ||
    !Array.isArray(candidate.entries)
  ) {
    return { reason: "rollback_artifact_invalid" };
  }
  const manifestDir = dirname(input.manifestPath);
  const entries: RollbackManifestEntry[] = [];
  for (const rawEntry of candidate.entries) {
    const entry = readManifestEntry(rawEntry);
    if (!entry) {
      return { reason: "rollback_artifact_invalid" };
    }
    for (const path of [entry.path, entry.oldPath, entry.newPath]) {
      if (path !== undefined && resolveContainedPath(input.workspaceRoot, path) === null) {
        return { reason: "rollback_artifact_invalid" };
      }
    }
    if (entry.beforeArtifactRef !== undefined) {
      const artifactPath = resolveContainedPath(input.workspaceRoot, entry.beforeArtifactRef);
      // Before-content captures are bound to the manifest's own patch-set
      // directory; a ref pointing anywhere else is not rollback material.
      if (artifactPath === null || relative(manifestDir, artifactPath).startsWith("..")) {
        return { reason: "rollback_artifact_invalid" };
      }
    }
    entries.push(entry);
  }
  return {
    manifest: {
      version: ROLLBACK_MANIFEST_VERSION,
      patchSetId: input.expectedPatchSetId,
      createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : 0,
      entries,
    },
  };
}

function manifestPathFor(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly applied: AppliedPatchSetRef;
}): string | null {
  if (input.applied.rollbackArtifactRef !== undefined) {
    // The apply receipt carries the artifact identity; never re-guess it
    // from directory conventions when evidence is available.
    return resolveContainedPath(input.workspaceRoot, input.applied.rollbackArtifactRef);
  }
  return join(
    resolveSessionPatchHistoryDirectory({
      workspaceRoot: input.workspaceRoot,
      sessionId: input.sessionId,
    }),
    input.applied.patchSetId,
    ROLLBACK_MANIFEST_FILE,
  );
}

/**
 * Resolve the latest applied patch set that has not been rolled back yet.
 * Discovery input (applied/rolled-back ids) comes from durable events; this
 * function only binds that evidence to on-disk rollback material.
 */
export function resolveLatestRollbackCandidate(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  /** Applied patch sets in tape order (oldest first), from apply receipts. */
  readonly appliedPatchSets: readonly AppliedPatchSetRef[];
  readonly rolledBackPatchSetIds: ReadonlySet<string>;
}): RollbackCandidateResolution {
  const remaining = input.appliedPatchSets.filter(
    (applied) => !input.rolledBackPatchSetIds.has(applied.patchSetId),
  );
  const applied = remaining.at(-1);
  if (!applied) {
    return { kind: "none", reason: "no_patchset" };
  }
  const manifestPath = manifestPathFor({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    applied,
  });
  if (manifestPath === null) {
    return { kind: "none", reason: "rollback_artifact_invalid" };
  }
  const validated = readValidatedManifest({
    workspaceRoot: input.workspaceRoot,
    manifestPath,
    expectedPatchSetId: applied.patchSetId,
  });
  if (validated.reason !== undefined) {
    return { kind: "none", reason: validated.reason };
  }
  return {
    kind: "candidate",
    candidate: {
      patchSetId: applied.patchSetId,
      manifestPath,
      manifest: validated.manifest,
      affectedPaths: validated.manifest.entries.map((entry) => entry.path),
    },
  };
}

interface PreflightFailure {
  readonly path: string;
  readonly reason: "conflict" | "rollback_artifact_missing";
}

function entryNeedsBeforeContent(entry: RollbackManifestEntry): boolean {
  if (entry.operation === "rename") {
    return false;
  }
  if (entry.operation === "delete") {
    return true;
  }
  return entry.beforeHash !== undefined;
}

type PathExpectation =
  | { readonly kind: "exists"; readonly hash?: string }
  | { readonly kind: "absent" };

/**
 * Simulate the post-apply world per path by replaying the manifest entries
 * in apply order. Preflight then validates the disk against this simulated
 * final state, which handles intra-patchset path interactions (a write that
 * is later renamed away, a delete followed by a re-create) and refuses to
 * restore over files the patch never produced — a rename target that gained
 * a new occupant is a conflict, not a silent overwrite.
 */
function buildPostApplyExpectations(
  entries: readonly RollbackManifestEntry[],
): Map<string, PathExpectation> {
  const expectations = new Map<string, PathExpectation>();
  for (const entry of entries) {
    if (entry.operation === "rename") {
      expectations.set(entry.path, { kind: "absent" });
      expectations.set(entry.newPath ?? entry.path, {
        kind: "exists",
        ...(entry.beforeHash !== undefined ? { hash: entry.beforeHash } : {}),
      });
      continue;
    }
    if (entry.operation === "delete") {
      expectations.set(entry.path, { kind: "absent" });
      continue;
    }
    expectations.set(entry.path, {
      kind: "exists",
      ...(entry.afterHash !== undefined ? { hash: entry.afterHash } : {}),
    });
  }
  return expectations;
}

function preflightArtifacts(
  workspaceRoot: string,
  entries: readonly RollbackManifestEntry[],
): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  for (const entry of entries) {
    if (!entryNeedsBeforeContent(entry)) {
      continue;
    }
    if (!entry.beforeArtifactRef || !existsSync(join(workspaceRoot, entry.beforeArtifactRef))) {
      failures.push({ path: entry.path, reason: "rollback_artifact_missing" });
    }
  }
  return failures;
}

function preflightWorldState(
  workspaceRoot: string,
  expectations: ReadonlyMap<string, PathExpectation>,
): PreflightFailure[] {
  const failures: PreflightFailure[] = [];
  for (const [path, expectation] of expectations) {
    const absolute = join(workspaceRoot, path);
    if (expectation.kind === "absent") {
      if (existsSync(absolute)) {
        failures.push({ path, reason: "conflict" });
      }
      continue;
    }
    if (!existsSync(absolute)) {
      failures.push({ path, reason: "conflict" });
      continue;
    }
    if (
      expectation.hash !== undefined &&
      contentHash(readFileSync(absolute, "utf8")) !== expectation.hash
    ) {
      failures.push({ path, reason: "conflict" });
    }
  }
  return failures;
}

function restoreEntry(workspaceRoot: string, entry: RollbackManifestEntry): void {
  if (entry.operation === "rename") {
    const from = join(workspaceRoot, entry.newPath ?? entry.path);
    const to = join(workspaceRoot, entry.oldPath ?? entry.path);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return;
  }
  const absolute = join(workspaceRoot, entry.path);
  if (entry.operation === "write" && entry.beforeArtifactRef === undefined) {
    // The mutation created this file; restoring means removing it.
    rmSync(absolute, { force: true });
    return;
  }
  if (!entry.beforeArtifactRef) {
    throw new Error(`rollback_before_artifact_missing:${entry.path}`);
  }
  const before = readFileSync(join(workspaceRoot, entry.beforeArtifactRef), "utf8");
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, before, "utf8");
}

/**
 * Restore the tracked mutations of one patch set. Preflight simulates the
 * post-apply world per path and validates the disk against it before any
 * file is touched, so conflicts — including a foreign file occupying a
 * rename's restore target — never produce partial mutation. Mutation
 * failures after a clean preflight surface as explicit partial failure,
 * never silence; a partially failed rollback leaves the patch set
 * un-rolled-back and requires manual recovery, by design.
 */
export function executePatchSetRollback(input: {
  readonly workspaceRoot: string;
  readonly candidate: PatchRollbackCandidate;
}): PatchRollbackExecution {
  const { workspaceRoot, candidate } = input;
  const failures = [
    ...preflightArtifacts(workspaceRoot, candidate.manifest.entries),
    ...preflightWorldState(workspaceRoot, buildPostApplyExpectations(candidate.manifest.entries)),
  ];
  if (failures.length > 0) {
    const artifactMissing = failures.some(
      (failure) => failure.reason === "rollback_artifact_missing",
    );
    return {
      ok: false,
      patchSetId: candidate.patchSetId,
      restoredPaths: [],
      failedPaths: failures.map((failure) => failure.path),
      reason: artifactMissing ? "rollback_artifact_missing" : "conflict",
    };
  }

  const restoredPaths: string[] = [];
  const failedPaths: string[] = [];
  for (const entry of candidate.manifest.entries.toReversed()) {
    try {
      restoreEntry(workspaceRoot, entry);
      restoredPaths.push(entry.operation === "rename" ? (entry.oldPath ?? entry.path) : entry.path);
    } catch {
      failedPaths.push(entry.path);
    }
  }
  if (failedPaths.length > 0) {
    return {
      ok: false,
      patchSetId: candidate.patchSetId,
      restoredPaths,
      failedPaths,
      reason: "partial_failure",
    };
  }
  return {
    ok: true,
    patchSetId: candidate.patchSetId,
    restoredPaths,
    failedPaths: [],
  };
}
