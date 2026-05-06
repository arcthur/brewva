import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../json.js";

const SNAPSHOT_KEEP_COUNT = 3;

export interface ReadSnapshotManifest {
  schemaVersion: number;
  snapshotFile: string;
  publishedAt: number;
  writerPid: number;
  indexedSessions: number;
  indexedEvents: number;
}

export function resolvePublishedReadSnapshotPath(input: {
  manifestPath: string;
  snapshotDir: string;
  schemaVersion: number;
}): string | undefined {
  const manifest = readReadSnapshotManifest(input.manifestPath, input.schemaVersion);
  if (!manifest) {
    return undefined;
  }
  const snapshotPath = resolve(input.snapshotDir, manifest.snapshotFile);
  return existsSync(snapshotPath) ? snapshotPath : undefined;
}

function readReadSnapshotManifest(
  manifestPath: string,
  schemaVersion: number,
): ReadSnapshotManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.schemaVersion !== schemaVersion) return undefined;
    if (typeof parsed.snapshotFile !== "string" || parsed.snapshotFile.length === 0) {
      return undefined;
    }
    if (typeof parsed.publishedAt !== "number" || !Number.isFinite(parsed.publishedAt)) {
      return undefined;
    }
    return {
      schemaVersion,
      snapshotFile: parsed.snapshotFile,
      publishedAt: parsed.publishedAt,
      writerPid:
        typeof parsed.writerPid === "number" && Number.isFinite(parsed.writerPid)
          ? parsed.writerPid
          : 0,
      indexedSessions:
        typeof parsed.indexedSessions === "number" && Number.isFinite(parsed.indexedSessions)
          ? parsed.indexedSessions
          : 0,
      indexedEvents:
        typeof parsed.indexedEvents === "number" && Number.isFinite(parsed.indexedEvents)
          ? parsed.indexedEvents
          : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeReadSnapshotManifest(
  manifestPath: string,
  manifest: ReadSnapshotManifest,
): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tempPath, manifestPath);
}

export function pruneReadSnapshots(snapshotDir: string, activeSnapshotFile: string): void {
  let entries: string[];
  try {
    entries = readdirSync(snapshotDir).filter((entry) => entry.endsWith(".duckdb"));
  } catch {
    return;
  }
  const stale = entries
    .filter((entry) => entry !== activeSnapshotFile)
    .map((entry) => {
      const path = join(snapshotDir, entry);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {}
      return { entry, path, mtimeMs };
    })
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(Math.max(0, SNAPSHOT_KEEP_COUNT - 1));
  for (const entry of stale) {
    try {
      rmSync(entry.path, { force: true });
    } catch {}
  }
}
