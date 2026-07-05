/**
 * The canonical read-model for "a tool ran this session."
 *
 * Every attention/feedback/provenance projection (fresh-code, recent paths,
 * skill adoption, review debt, session-touched files) needs the same fact:
 * which tools executed, named what, touching which paths. That fact has a
 * single authoritative home on the tape — the kernel COMMITMENT boundary
 * (`tool.committed`), which is brewva's transaction-of-record: a tool that
 * committed ran; a blocked or aborted call never commits. Projections used to
 * read the runtime-ops annotation `tool.invocation.started` instead, which the
 * hosted managed-session path does not emit (zero occurrences across every
 * real hosted tape) — so an entire family of model-attention signals shipped
 * green on synthetic-event unit tests and ran dead in production.
 *
 * This module is that single source. Consumers project once and read the
 * normalized `ToolInvocation`; no consumer names a raw event kind again, so the
 * read-side and the tape can never silently disagree about what a tool run is.
 */

/** The kernel commitment event: a tool call that ran to completion. Authoritative. */
export const TOOL_COMMITTED_EVENT_TYPE = "tool.committed" as const;

/** Commitment outcome grade, as carried on `result.outcome.kind`. */
export type ToolInvocationOutcome = "ok" | "err" | "inconclusive";

/**
 * One committed tool run, normalized. `args` is the tool's own argument record
 * (`path`/`file_path`/`uri`/`paths`/`edits`/`workdir`/...); `outcome` is the
 * commitment grade. A blocked/aborted call is absent by construction (it never
 * commits), so there is no `allowed` flag to check — presence IS "it ran."
 */
export interface ToolInvocation {
  readonly toolCallId: string | null;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly timestamp: number;
  readonly outcome: ToolInvocationOutcome | null;
}

/** The minimal event shape this read-model folds — a `BrewvaEventRecord` satisfies it. */
export interface CommitmentScanEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOutcome(payload: Record<string, unknown>): ToolInvocationOutcome | null {
  const result = asRecord(payload.result);
  const outcome = result ? asRecord(result.outcome) : null;
  const kind = outcome?.kind;
  return kind === "ok" || kind === "err" || kind === "inconclusive" ? kind : null;
}

/**
 * Project the tape into the tools that actually ran, tape order preserved. Reads
 * only `tool.committed`; the `call` envelope carries `toolName`/`args`/
 * `toolCallId`, the outcome comes off `result.outcome.kind`. An event missing a
 * usable `call.toolName` is skipped rather than yielding a nameless invocation.
 */
export function projectToolInvocations(events: readonly CommitmentScanEvent[]): ToolInvocation[] {
  const invocations: ToolInvocation[] = [];
  for (const event of events) {
    if (event.type !== TOOL_COMMITTED_EVENT_TYPE) continue;
    const payload = asRecord(event.payload);
    if (!payload) continue;
    const call = asRecord(payload.call);
    if (!call) continue;
    const toolName = call.toolName;
    if (typeof toolName !== "string" || toolName.length === 0) continue;
    invocations.push({
      toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : null,
      toolName,
      args: asRecord(call.args) ?? {},
      timestamp: typeof event.timestamp === "number" ? event.timestamp : 0,
      outcome: readOutcome(payload),
    });
  }
  return invocations;
}

/**
 * Write-class tools: those whose commitment mutates the working tree. The shared
 * basis for "fresh code was written this session" — the post-green review nudge,
 * the intent-realization fresh-code signal, and the tree-mutation timestamp all
 * read this one set.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "source_patch_apply",
]);

/**
 * Bare-write tools whose target FILE path must be read from their args to build
 * the fresh-touched-file universe. A SUBSET of {@link WRITE_TOOL_NAMES}:
 * `source_patch_apply`'s touched paths come authoritatively from the
 * `source_patch_applied` receipt's `appliedPaths`, not its args.
 */
export const BARE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/** A committed write counts as tree-mutating unless it explicitly errored. */
function ranSuccessfully(invocation: ToolInvocation): boolean {
  return invocation.outcome !== "err";
}

/**
 * Did any write-class tool commit successfully this session? A committed write
 * that did not error mutated the tree; an errored or absent (blocked/aborted)
 * one did not. This is the fresh-code predicate the review-debt and post-green
 * projections gate on.
 */
export function projectFreshCodeWritten(invocations: readonly ToolInvocation[]): boolean {
  return invocations.some(
    (invocation) => WRITE_TOOL_NAMES.has(invocation.toolName) && ranSuccessfully(invocation),
  );
}

/**
 * One bare-write's target path (parsed, or null when unreadable) plus the root
 * to relativize it against. Commitment args carry ABSOLUTE paths, so `cwd`
 * carries the session workspace root (or null for a pure tape read with no root
 * available); the fresh-touched-universe normalizer strips it. `cwd` is the same
 * field the review targetRef normalizer keys on, so the shape stays one.
 */
export interface WriteInvocationPath {
  readonly path: string | null;
  readonly cwd: string | null;
}

/**
 * The primary path-like argument of a committed tool call (`path`/`file_path`/
 * `filePath`/`uri`, in that precedence), or null when none is a usable string.
 * THE one reader of a commitment's target path — the write-touched universe and
 * the compaction file provenance both fold it, so the arg-key set can never
 * drift between them.
 */
export function readToolArgPath(args: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "uri"] as const) {
    const candidate = args[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * Each bare-write (write/edit) invocation's target path, for the fresh-touched
 * file universe. A committed write with an unparseable path yields `{ path:
 * null }`, which makes the universe not-fully-known downstream (conservative:
 * coverage can never be proven, so debt shows rather than falsely clears).
 *
 * Commitment paths are ABSOLUTE, so `workspaceRoot` is carried through on each
 * entry's `cwd` for the downstream normalizer to relativize against — every
 * debt-clearing caller must pass the session root, so the read-model owns the
 * remap instead of each caller re-mapping it. A pure tape read with no root
 * available (`buildTapeReviewDebt`) omits it (null → paths stay absolute,
 * conservatively over-showing debt on a display surface, never falsely clearing).
 */
export function extractWriteInvocationPaths(
  invocations: readonly ToolInvocation[],
  workspaceRoot: string | null = null,
): WriteInvocationPath[] {
  const paths: WriteInvocationPath[] = [];
  for (const invocation of invocations) {
    if (!BARE_WRITE_TOOL_NAMES.has(invocation.toolName) || !ranSuccessfully(invocation)) continue;
    paths.push({ path: readToolArgPath(invocation.args), cwd: workspaceRoot });
  }
  return paths;
}

/**
 * Strip the session workspace root from an absolute commitment path so it
 * matches workspace-relative signals (skill path-globs, compaction provenance).
 * Commitment args carry ABSOLUTE targets; a skill scoped to `src/payment/**`
 * must match a commit of `/repo/src/payment/checkout.ts`. A path OUTSIDE the
 * workspace stays absolute (and correctly never matches a workspace glob). The
 * root is the session's single workspace root — commitment events carry no
 * per-call cwd, and every invocation in a session shares that root. THE one
 * relativizer for both the skill-recall and compaction-provenance read paths.
 */
export function relativizeToWorkspace(target: string, workspaceRoot: string | null): string {
  if (!workspaceRoot || !target.startsWith("/")) {
    return target;
  }
  const root = workspaceRoot.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (root.length === 0) {
    return target;
  }
  if (target === root) {
    return "";
  }
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

/**
 * The latest timestamp at which the working tree was mutated, or null. A tree
 * mutation is a successful `source_patch_applied`/`rollback.recorded` receipt,
 * OR a bare-write (write/edit) commitment — both rewrite files, so both advance
 * the timestamp or a post-review edit would leave a receipt wrongly fresh. The
 * write side reads the same {@link BARE_WRITE_TOOL_NAMES} the universe uses.
 */
export function deriveLatestTreeMutationAt(input: {
  readonly patchRollbackEvents: readonly CommitmentScanEvent[];
  readonly writeInvocations: readonly ToolInvocation[];
}): number | null {
  let latest: number | null = null;
  const advance = (timestamp: number | undefined): void => {
    if (typeof timestamp !== "number") return;
    latest = latest === null ? timestamp : Math.max(latest, timestamp);
  };
  for (const event of input.patchRollbackEvents) {
    const payload = asRecord(event.payload);
    if (payload && payload.ok === true) {
      advance(event.timestamp);
    }
  }
  for (const invocation of input.writeInvocations) {
    if (BARE_WRITE_TOOL_NAMES.has(invocation.toolName) && ranSuccessfully(invocation)) {
      advance(invocation.timestamp);
    }
  }
  return latest;
}
