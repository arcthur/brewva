import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, writeFileAtomic } from "@brewva/brewva-std/node/fs";
import type { HistoryViewBaselineSnapshot } from "./types.js";

const HISTORY_VIEW_BASELINE_ARTIFACT_SCHEMA_VERSION = 1;
const ORCHESTRATOR_DIR = ".orchestrator";
const HISTORY_VIEW_DIR = "history-view";
const SESSIONS_DIR = "sessions";
const ENCODED_SESSION_PREFIX = "sess_";
const BASELINE_ARTIFACT_FILE = "baseline.json";

interface StoredHistoryViewBaselineArtifact {
  schemaVersion: number;
  snapshot: HistoryViewBaselineSnapshot;
}

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function buildHistoryViewBaselineArtifactPath(workspaceRoot: string, sessionId: string): string {
  return join(
    workspaceRoot,
    ORCHESTRATOR_DIR,
    HISTORY_VIEW_DIR,
    SESSIONS_DIR,
    `${ENCODED_SESSION_PREFIX}${encodeSessionId(sessionId)}`,
    BASELINE_ARTIFACT_FILE,
  );
}

function isHistoryViewBaselineSnapshot(value: unknown): value is HistoryViewBaselineSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<HistoryViewBaselineSnapshot>;
  return (
    typeof candidate.compactId === "string" &&
    typeof candidate.sanitizedSummary === "string" &&
    typeof candidate.summaryDigest === "string" &&
    typeof candidate.sourceTurn === "number" &&
    (candidate.leafEntryId === null || typeof candidate.leafEntryId === "string") &&
    (candidate.referenceContextDigest === null ||
      typeof candidate.referenceContextDigest === "string") &&
    (candidate.fromTokens === null || typeof candidate.fromTokens === "number") &&
    (candidate.toTokens === null || typeof candidate.toTokens === "number") &&
    typeof candidate.origin === "string" &&
    typeof candidate.eventId === "string" &&
    typeof candidate.timestamp === "number" &&
    (candidate.rebuildSource === "artifact" || candidate.rebuildSource === "receipt") &&
    Array.isArray(candidate.diagnostics)
  );
}

export function readHistoryViewBaselineArtifact(
  workspaceRoot: string,
  sessionId: string,
): HistoryViewBaselineSnapshot | undefined {
  const filePath = buildHistoryViewBaselineArtifactPath(workspaceRoot, sessionId);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as Partial<StoredHistoryViewBaselineArtifact>;
    if (
      raw.schemaVersion !== HISTORY_VIEW_BASELINE_ARTIFACT_SCHEMA_VERSION ||
      !isHistoryViewBaselineSnapshot(raw.snapshot)
    ) {
      return undefined;
    }
    return { ...raw.snapshot, rebuildSource: "artifact" };
  } catch {
    return undefined;
  }
}

export function writeHistoryViewBaselineArtifact(
  workspaceRoot: string,
  sessionId: string,
  snapshot: HistoryViewBaselineSnapshot,
): void {
  const filePath = buildHistoryViewBaselineArtifactPath(workspaceRoot, sessionId);
  ensureDir(dirname(filePath));
  const artifact: StoredHistoryViewBaselineArtifact = {
    schemaVersion: HISTORY_VIEW_BASELINE_ARTIFACT_SCHEMA_VERSION,
    snapshot: { ...snapshot, rebuildSource: "artifact" },
  };
  writeFileAtomic(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
}

export function deleteHistoryViewBaselineArtifact(workspaceRoot: string, sessionId: string): void {
  const filePath = buildHistoryViewBaselineArtifactPath(workspaceRoot, sessionId);
  rmSync(filePath, { force: true });
}

export function getHistoryViewBaselineArtifactPath(
  workspaceRoot: string,
  sessionId: string,
): string {
  return buildHistoryViewBaselineArtifactPath(workspaceRoot, sessionId);
}
