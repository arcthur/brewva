import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export const FILE_SNAPSHOT_CAPTURED_EVENT_TYPE = "file.snapshot.captured" as const;

export const PATCH_RECORDED_EVENT_TYPE = "patch.recorded" as const;

export const REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE = "reversible_mutation.prepared" as const;

export const REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE = "reversible_mutation.recorded" as const;

export const REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE =
  "reversible_mutation.rolled_back" as const;

export const ROLLBACK_EVENT_TYPE = "rollback.recorded" as const;
export const ROLLBACK_STARTED_EVENT_TYPE = "rollback.started" as const;

export const SOURCE_PATCH_APPLIED_EVENT_TYPE = "source_patch_applied" as const;

export const SOURCE_PATCH_PREPARED_EVENT_TYPE = "source_patch_prepared" as const;

export const SOURCE_PATCH_STALE_RECOVERED_EVENT_TYPE = "source_patch_stale_recovered" as const;

export const SOURCE_RESOURCE_READ_EVENT_TYPE = "source_resource_read" as const;

export const SOURCE_SNAPSHOT_RECORDED_EVENT_TYPE = "source_snapshot_recorded" as const;

export const WORKBENCH_EVICTION_RECORDED_EVENT_TYPE = "workbench.eviction.recorded" as const;

export const WORKBENCH_EVICTION_UNDONE_EVENT_TYPE = "workbench.eviction.undone" as const;

export const WORKBENCH_NOTE_RECORDED_EVENT_TYPE = "workbench.note.recorded" as const;

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
   * Model-authored salience hint recorded when the note is written (for example
   * `"attention_pin"`). Persisted as model-sovereign retention evidence; only
   * promotion-eligible hints become promotion signals.
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
