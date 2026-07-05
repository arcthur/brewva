import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrewvaEventRecord } from "./events.js";
import type { RcrReference } from "./rcr.js";
import { optionalStringField } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";
import type {
  PersistedPatchChange,
  PersistedPatchHistory,
  PersistedPatchSet,
} from "./types/patch.js";

export type { ProtocolRecord } from "./types/foundation.js";

export type {
  PatchConflict,
  PatchFileAction,
  PatchFileChange,
  PatchRollbackCandidateView,
  PatchRollbackFailureReason,
  PatchRollbackResult,
  PatchSet,
  PersistedPatchChange,
  PersistedPatchHistory,
  PersistedPatchSet,
} from "./types/patch.js";

export type {
  SourceLineAnchor,
  SourcePatchApplyResult,
  SourcePatchConflict,
  SourcePatchIntent,
  SourcePatchPlan,
  SourcePatchPreflight,
  SourcePatchStaleRecoveryRecord,
  SourceResourceDescriptor,
  SourceSnapshot,
} from "./types/source-patch.js";

export const PATCH_HISTORY_FILE = "patch-history.json" as const;

export function sanitizePatchHistorySessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function readPatchPathInput(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): { readonly root: string; readonly sessionId: string } {
  if (typeof rootOrInput === "string") {
    return { root: rootOrInput, sessionId: sessionId ?? "default" };
  }
  return {
    root:
      optionalStringField(rootOrInput, "root") ??
      optionalStringField(rootOrInput, "workspaceRoot") ??
      optionalStringField(rootOrInput, "path") ??
      ".",
    sessionId: optionalStringField(rootOrInput, "sessionId") ?? "default",
  };
}

export function resolveSessionPatchHistoryDirectory(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): string {
  const { root, sessionId: resolvedSessionId } = readPatchPathInput(rootOrInput, sessionId);
  return resolve(root, sanitizePatchHistorySessionId(resolvedSessionId));
}

export function resolveSessionPatchHistoryPath(
  rootOrInput: string | ProtocolRecord,
  sessionId?: string,
): string {
  return join(resolveSessionPatchHistoryDirectory(rootOrInput, sessionId), PATCH_HISTORY_FILE);
}

export function readPersistedPatchHistory(path: string): PersistedPatchHistory {
  if (!existsSync(path)) return { patches: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedPatchHistory>;
  return {
    patches: Array.isArray(parsed.patches)
      ? parsed.patches.map((patchSet) =>
          Object.assign({}, patchSet, {
            changes: Array.isArray(patchSet.changes) ? patchSet.changes : [],
          }),
        )
      : [],
  };
}

export function listPersistedPatchSets(pathOrInput: string | ProtocolRecord): PersistedPatchSet[] {
  const path =
    typeof pathOrInput === "string"
      ? pathOrInput
      : (optionalStringField(pathOrInput, "path") ??
        resolveSessionPatchHistoryPath(
          optionalStringField(pathOrInput, "workspaceRoot") ??
            optionalStringField(pathOrInput, "root") ??
            ".",
          optionalStringField(pathOrInput, "sessionId"),
        ));
  return [...readPersistedPatchHistory(path).patches];
}

export function collectPersistedPatchPaths(
  root: string | readonly PersistedPatchSet[],
  options: { readonly ignoredPrefixes?: readonly string[] } = {},
): Set<string> {
  const ignoredPrefixes = options.ignoredPrefixes ?? [];
  const includePath = (path: string): boolean =>
    path.length > 0 && !ignoredPrefixes.some((prefix) => path.startsWith(prefix));
  if (typeof root !== "string") {
    return new Set(
      root.flatMap((patchSet) =>
        (patchSet.changes ?? [])
          .flatMap((change: PersistedPatchChange): readonly unknown[] => [
            change.path,
            change.newPath,
            change.oldPath,
          ])
          .filter((path): path is string => typeof path === "string" && includePath(path)),
      ),
    );
  }
  if (!existsSync(root)) return new Set();
  return new Set(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.name === PATCH_HISTORY_FILE)
      .map((entry) =>
        entry.isDirectory() ? join(root, entry.name, PATCH_HISTORY_FILE) : join(root, entry.name),
      )
      .filter((path) => existsSync(path) && includePath(path)),
  );
}

export const ROLLBACK_EVENT_TYPE = "rollback.recorded" as const;
export const ROLLBACK_STARTED_EVENT_TYPE = "rollback.started" as const;

export const SOURCE_PATCH_APPLIED_EVENT_TYPE = "source_patch_applied" as const;

/**
 * Pure tape fold: which patch-set ids are currently applied, given the full
 * event history? A patch set counts once a `source_patch_applied` receipt
 * with `payload.ok === true` names it, and stops counting once a
 * `rollback.recorded` receipt names it — re-applying the same id after a
 * rollback restores it. Order in the returned array is first-applied-first
 * (tape order), deduplicated; the caller decides whether order matters.
 *
 * Shared by the rewind engine's checkpoint-window derivation (gateway
 * recovery) and the review-debt projection's `matchesTree` (tools runtime
 * port) — both need "what is applied right now," so this is the one
 * definition instead of two copies of the same applied-minus-rolled-back
 * scan.
 */
export function deriveAppliedPatchSetIds(events: readonly BrewvaEventRecord[]): readonly string[] {
  const applied: string[] = [];
  const rolledBack = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    // A failed rollback (ok: false) never actually restored the patch set's
    // files, so it must not count as removing the patch set from "applied" —
    // same "ok gates whether this receipt is honored" rule for both event
    // types, matching the rewind engine's existing checkpoint-window scan.
    if (!payload || typeof payload !== "object" || payload.ok !== true) {
      continue;
    }
    const patchSetId = typeof payload.patchSetId === "string" ? payload.patchSetId : undefined;
    if (!patchSetId) {
      continue;
    }
    if (event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE) {
      rolledBack.delete(patchSetId);
      if (!applied.includes(patchSetId)) {
        applied.push(patchSetId);
      }
    } else if (event.type === ROLLBACK_EVENT_TYPE) {
      rolledBack.add(patchSetId);
    }
  }
  return applied.filter((patchSetId) => !rolledBack.has(patchSetId));
}

/**
 * Map each successfully-applied patch set id to its `source_patch_applied`
 * receipt's `appliedPaths` (ok === true) — the patch-set→files index the
 * review-debt coverage join needs (a `patch_sets` targetRef's attested files
 * are the union of its sets' appliedPaths). Single-homed here beside
 * {@link deriveAppliedPatchSetIds}: both the live (`runtime-port/verification`)
 * and tape (`cli/review-debt`) debt shells derive it through ONE definition.
 * Not reduced by rollbacks on purpose — the caller's universe is
 * superset-leaning (a patched-then-rolled-back file stays in the set), which
 * can only make coverage harder, never falsely clear debt.
 */
export function collectPatchSetAppliedPaths(
  events: readonly BrewvaEventRecord[],
): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (const event of events) {
    if (event.type !== SOURCE_PATCH_APPLIED_EVENT_TYPE) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as { ok?: unknown; patchSetId?: unknown; appliedPaths?: unknown };
    if (record.ok !== true || typeof record.patchSetId !== "string") continue;
    const appliedPaths = Array.isArray(record.appliedPaths)
      ? record.appliedPaths.filter((path): path is string => typeof path === "string")
      : [];
    map[record.patchSetId] = appliedPaths;
  }
  return map;
}

export const SOURCE_PATCH_PREPARED_EVENT_TYPE = "source_patch_prepared" as const;

export const SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE = "source_patch_stale_recovered" as const;

export const SOURCE_RESOURCE_READ_EVENT_TYPE = "source_resource_read" as const;

export const SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE = "source_snapshot_recorded" as const;

export const WORKBENCH_EVICTION_RECORDED_EVENT_TYPE = "workbench.eviction.recorded" as const;

export const WORKBENCH_EVICTION_UNDONE_EVENT_TYPE = "workbench.eviction.undone" as const;

export const WORKBENCH_NOTE_RECORDED_EVENT_TYPE = "workbench.note.recorded" as const;

/**
 * The one contractual `retentionHint` value: entries carrying it are excluded
 * from every compaction/eviction candidate set and carried verbatim across
 * compaction baselines. An explicit `workbench_evict` targeting `entry:<id>`
 * is the only removal path. Any other hint string is advisory evidence, not a
 * contract.
 */
export const ATTENTION_PIN_RETENTION_HINT = "attention_pin" as const;

export function isAttentionPinnedWorkbenchEntry(
  entry: Pick<WorkbenchEntry, "retentionHint">,
): boolean {
  return entry.retentionHint === ATTENTION_PIN_RETENTION_HINT;
}

export interface WorkbenchEntry extends ProtocolRecord {
  readonly id?: string;
  readonly kind?: string;
  readonly digest: string;
  readonly content?: string;
  readonly text?: string;
  readonly preservedQuotes?: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly reason: string;
  readonly createdTurn?: number;
  readonly reversible?: boolean;
  readonly rcr?: readonly RcrReference[];
  /**
   * Model-authored salience hint recorded when the note is written. The value
   * {@link ATTENTION_PIN_RETENTION_HINT} is contractual (survival across
   * compaction/eviction, enforced by the gateway selection physics); any other
   * string is advisory salience evidence only.
   */
  readonly retentionHint?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export const WORKBENCH_EVICTION_SPAN_REF_PREFIXES = [
  "turn",
  "message",
  "tool",
  "event",
  "entry",
] as const;

export interface WorkbenchEvictionSpanRef {
  readonly prefix: (typeof WORKBENCH_EVICTION_SPAN_REF_PREFIXES)[number];
  readonly id: string;
  readonly value: string;
  readonly normalized: string;
}

export function listInvalidWorkbenchEvictionSpanRefs(refs: readonly string[]): readonly string[] {
  return refs.filter((ref) => parseWorkbenchEvictionSpanRef(ref) === null);
}

export function parseWorkbenchEvictionSpanRef(ref: string): WorkbenchEvictionSpanRef | null {
  const trimmed = ref.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  const prefix = trimmed.slice(0, separator).trim();
  const value = trimmed.slice(separator + 1).trim();
  if (!WORKBENCH_EVICTION_SPAN_REF_PREFIXES.includes(prefix as never)) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  return {
    prefix: prefix as (typeof WORKBENCH_EVICTION_SPAN_REF_PREFIXES)[number],
    id: value,
    value,
    normalized: `${prefix}:${value}`,
  };
}
