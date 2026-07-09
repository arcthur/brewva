import type { WorldManifest } from "./types.js";

export type WorldFileChange = "added" | "modified" | "deleted";

export interface WorldFileDiff {
  readonly path: string;
  readonly change: WorldFileChange;
  /** The `sha256:<hex>` blob on the BEFORE side, or null when the file was added. */
  readonly beforeBlob: string | null;
  /** The `sha256:<hex>` blob on the AFTER side, or null when the file was deleted. */
  readonly afterBlob: string | null;
}

export interface WorldDiff {
  /** Changed files only (identical files are omitted), sorted by path. */
  readonly files: readonly WorldFileDiff[];
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
}

/**
 * Pure content-addressed diff of two world manifests. Content addressing makes this a
 * plain per-path comparison: a differing blob (or exec-bit) is a modification, a
 * one-sided path is an add/delete, an identical (blob + mode) path is omitted entirely.
 * No I/O — blobs are compared by their `sha256:` id, never read. Deterministic and
 * path-sorted, so the same manifests always yield a byte-identical diff.
 */
export function projectWorldDiff(before: WorldManifest, after: WorldManifest): WorldDiff {
  const beforeByPath = new Map(before.files.map((entry) => [entry.path, entry] as const));
  const afterByPath = new Map(after.files.map((entry) => [entry.path, entry] as const));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].toSorted();

  const files: WorldFileDiff[] = [];
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const path of paths) {
    const beforeEntry = beforeByPath.get(path);
    const afterEntry = afterByPath.get(path);
    if (beforeEntry && afterEntry) {
      // Content addressing: same blob AND same mode means identical — omit from the diff.
      if (beforeEntry.blob !== afterEntry.blob || beforeEntry.mode !== afterEntry.mode) {
        files.push({
          path,
          change: "modified",
          beforeBlob: beforeEntry.blob,
          afterBlob: afterEntry.blob,
        });
        modified += 1;
      }
    } else if (afterEntry) {
      files.push({ path, change: "added", beforeBlob: null, afterBlob: afterEntry.blob });
      added += 1;
    } else if (beforeEntry) {
      files.push({ path, change: "deleted", beforeBlob: beforeEntry.blob, afterBlob: null });
      deleted += 1;
    }
  }
  return { files, added, modified, deleted };
}
