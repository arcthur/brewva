import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  PatchApplyResult,
  PatchFileAction,
  PatchSet,
  RedoResult,
  RollbackResult,
} from "../contracts/index.js";
import { ensureDir, writeFileAtomic } from "../utils/fs.js";
import { sha256 } from "../utils/hash.js";
import { isMutationTool } from "../verification/classifier.js";
import {
  PATCH_HISTORY_FILE,
  readPersistedPatchHistory,
  type PersistedPatchHistory,
} from "./patch-history.js";
import {
  collectPathCandidates,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
} from "./workspace-paths.js";

const EXTRA_MUTATION_TOOLS = new Set(["multi_edit"]);
const MAX_HISTORY = 64;

interface TrackedFileState {
  absolutePath: string;
  relativePath: string;
  beforeExists: boolean;
  beforeHash?: string;
  beforeSnapshotPath?: string;
}

interface PendingMutation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  trackedFiles: TrackedFileState[];
  startedAt: number;
}

interface AppliedMutation {
  patchSet: PatchSet;
  toolName: string;
  appliedAt: number;
  changes: Array<
    TrackedFileState & {
      action: PatchFileAction;
      afterExists: boolean;
      afterHash?: string;
      afterSnapshotPath?: string;
    }
  >;
  status: "applied" | "undone" | "redone";
  undoneAt?: number;
  redoneAt?: number;
}

type AppliedChange = AppliedMutation["changes"][number];

interface FileChangeTrackerOptions {
  snapshotsDir?: string;
  artifactsBaseDir?: string;
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function shouldTrackMutationTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return false;
  return isMutationTool(normalized) || EXTRA_MUTATION_TOOLS.has(normalized);
}

function buildPatchSetId(now: number): string {
  return `patch_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function snapshotFileName(path: string): string {
  return basename(path);
}

export class FileChangeTracker {
  private readonly cwd: string;
  private readonly snapshotsDir: string;
  private readonly pendingBySession = new Map<string, Map<string, PendingMutation>>();
  private readonly historyBySession = new Map<string, AppliedMutation[]>();
  private readonly loadedSessions = new Set<string>();

  constructor(cwd: string, options: string | FileChangeTrackerOptions = ".orchestrator/snapshots") {
    const normalizedOptions: FileChangeTrackerOptions =
      typeof options === "string" ? { snapshotsDir: options } : options;
    const snapshotsDir = normalizedOptions.snapshotsDir ?? ".orchestrator/snapshots";
    const artifactsBaseDir = resolve(normalizedOptions.artifactsBaseDir ?? cwd);
    this.cwd = resolve(cwd);
    this.snapshotsDir = resolve(artifactsBaseDir, snapshotsDir);
    ensureDir(this.snapshotsDir);
  }

  captureBeforeToolCall(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): { trackedFiles: string[] } {
    if (!shouldTrackMutationTool(input.toolName)) {
      return { trackedFiles: [] };
    }
    this.ensureHistoryLoaded(input.sessionId);

    const pendingForSession = this.getOrCreatePending(input.sessionId);
    if (pendingForSession.has(input.toolCallId)) {
      const existing = pendingForSession.get(input.toolCallId);
      return { trackedFiles: existing?.trackedFiles.map((item) => item.relativePath) ?? [] };
    }

    const trackedByPath = new Map<string, TrackedFileState>();
    const candidates = collectPathCandidates(input.args ?? {}, {
      keyPattern: /(path|file)/i,
    });
    for (const candidate of candidates) {
      const resolvedPath = resolveWorkspacePath({
        candidate,
        cwd: this.cwd,
        workspaceRoot: this.cwd,
      });
      if (!resolvedPath) continue;
      if (trackedByPath.has(resolvedPath.absolutePath)) continue;
      const snapshot = this.captureFileSnapshot(
        input.sessionId,
        resolvedPath.absolutePath,
        resolvedPath.relativePath,
      );
      trackedByPath.set(resolvedPath.absolutePath, snapshot);
    }

    const trackedFiles = [...trackedByPath.values()];
    pendingForSession.set(input.toolCallId, {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      trackedFiles,
      startedAt: Date.now(),
    });

    return { trackedFiles: trackedFiles.map((item) => item.relativePath) };
  }

  completeToolCall(input: {
    sessionId: string;
    toolCallId: string;
    channelSuccess: boolean;
  }): PatchSet | undefined {
    this.ensureHistoryLoaded(input.sessionId);
    const pendingForSession = this.pendingBySession.get(input.sessionId);
    const pending = pendingForSession?.get(input.toolCallId);
    if (!pending) return undefined;

    pendingForSession?.delete(input.toolCallId);
    if (!input.channelSuccess) return undefined;

    const changedFiles: AppliedMutation["changes"] = [];
    for (const tracked of pending.trackedFiles) {
      const afterExists = existsSync(tracked.absolutePath);
      const afterContent = afterExists ? readFileSync(tracked.absolutePath) : undefined;
      const afterHash = afterContent ? sha256(afterContent) : undefined;
      const action = this.resolveAction({
        beforeExists: tracked.beforeExists,
        afterExists,
        beforeHash: tracked.beforeHash,
        afterHash,
      });
      if (!action) continue;
      changedFiles.push({
        ...tracked,
        action,
        afterExists,
        afterHash,
        afterSnapshotPath: afterContent
          ? this.writeFileSnapshot(input.sessionId, tracked.relativePath, afterContent)
          : undefined,
      });
    }

    if (changedFiles.length === 0) {
      return undefined;
    }

    const now = Date.now();
    const patchSet: PatchSet = {
      id: buildPatchSetId(now),
      createdAt: now,
      summary: `${pending.toolName}: ${changedFiles.length} file(s)`,
      changes: changedFiles.map((item) => ({
        path: item.relativePath,
        action: item.action,
        beforeHash: item.beforeHash,
        afterHash: item.afterHash,
      })),
    };

    const history = this.getOrCreateHistory(input.sessionId);
    history.push({
      patchSet,
      toolName: pending.toolName,
      appliedAt: now,
      status: "applied",
      changes: changedFiles,
    });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    this.persistHistory(input.sessionId);
    return patchSet;
  }

  applyPatchSet(
    sessionId: string,
    input: {
      patchSet: PatchSet;
      toolName: string;
    },
  ): PatchApplyResult {
    this.ensureHistoryLoaded(sessionId);
    if (input.patchSet.changes.length === 0) {
      return {
        ok: false,
        patchSetId: input.patchSet.id,
        appliedPaths: [],
        failedPaths: [],
        reason: "empty_patchset",
      };
    }

    const validated: AppliedMutation["changes"] = [];
    const artifactBuffers = new Map<string, Buffer>();

    for (const change of input.patchSet.changes) {
      const resolvedPath = resolveWorkspacePath({
        candidate: change.path,
        cwd: this.cwd,
        workspaceRoot: this.cwd,
      });
      if (!resolvedPath) {
        return {
          ok: false,
          patchSetId: input.patchSet.id,
          appliedPaths: [],
          failedPaths: [change.path],
          reason: "invalid_path",
        };
      }

      const beforeExists = existsSync(resolvedPath.absolutePath);
      const beforeHash = beforeExists ? sha256(readFileSync(resolvedPath.absolutePath)) : undefined;
      const expectedBeforeHash = change.beforeHash?.trim();
      if (change.action === "add" && beforeExists) {
        return {
          ok: false,
          patchSetId: input.patchSet.id,
          appliedPaths: [],
          failedPaths: [change.path],
          reason: "before_hash_mismatch",
        };
      }
      if (change.action !== "add") {
        if (!beforeExists) {
          return {
            ok: false,
            patchSetId: input.patchSet.id,
            appliedPaths: [],
            failedPaths: [change.path],
            reason: "before_hash_mismatch",
          };
        }
        if (expectedBeforeHash && beforeHash !== expectedBeforeHash) {
          return {
            ok: false,
            patchSetId: input.patchSet.id,
            appliedPaths: [],
            failedPaths: [change.path],
            reason: "before_hash_mismatch",
          };
        }
      }

      let afterHash = change.afterHash;
      if (change.action !== "delete") {
        const artifactRef = change.artifactRef?.trim();
        const artifactPath = artifactRef
          ? resolveWorkspacePath({
              candidate: artifactRef,
              cwd: this.cwd,
              workspaceRoot: this.cwd,
            })
          : undefined;
        if (!artifactRef || !artifactPath || !existsSync(artifactPath.absolutePath)) {
          return {
            ok: false,
            patchSetId: input.patchSet.id,
            appliedPaths: [],
            failedPaths: [change.path],
            reason: "missing_artifact",
          };
        }
        const artifactContent = readFileSync(artifactPath.absolutePath);
        const artifactHash = sha256(artifactContent);
        if (change.afterHash && artifactHash !== change.afterHash) {
          return {
            ok: false,
            patchSetId: input.patchSet.id,
            appliedPaths: [],
            failedPaths: [change.path],
            reason: "after_hash_mismatch",
          };
        }
        artifactBuffers.set(change.path, artifactContent);
        afterHash = artifactHash;
      }

      const snapshot = this.captureFileSnapshot(
        sessionId,
        resolvedPath.absolutePath,
        resolvedPath.relativePath,
      );
      validated.push({
        ...snapshot,
        action: change.action,
        afterExists: change.action !== "delete",
        afterHash,
      });
    }

    const appliedPaths: string[] = [];
    try {
      for (const change of validated) {
        if (change.action === "delete") {
          if (existsSync(change.absolutePath)) {
            rmSync(change.absolutePath, { force: true });
          }
        } else {
          const artifactContent = artifactBuffers.get(change.relativePath);
          if (!artifactContent) {
            throw new Error(`Missing artifact buffer for ${change.relativePath}`);
          }
          writeFileAtomic(change.absolutePath, artifactContent);
          change.afterSnapshotPath = this.writeFileSnapshot(
            sessionId,
            change.relativePath,
            artifactContent,
          );
        }
        appliedPaths.push(change.relativePath);
      }
    } catch {
      const rollbackFailedPaths: string[] = [];
      for (const change of validated.toReversed()) {
        if (!appliedPaths.includes(change.relativePath)) {
          continue;
        }
        try {
          if (change.beforeExists) {
            if (!change.beforeSnapshotPath || !existsSync(change.beforeSnapshotPath)) {
              throw new Error(`Missing snapshot for ${change.relativePath}`);
            }
            writeFileAtomic(change.absolutePath, readFileSync(change.beforeSnapshotPath));
          } else if (existsSync(change.absolutePath)) {
            rmSync(change.absolutePath, { force: true });
          }
        } catch {
          rollbackFailedPaths.push(change.relativePath);
        }
      }

      return {
        ok: false,
        patchSetId: input.patchSet.id,
        appliedPaths: [],
        failedPaths: rollbackFailedPaths.length > 0 ? rollbackFailedPaths : [...appliedPaths],
        reason: "write_failed",
      };
    }

    const history = this.getOrCreateHistory(sessionId);
    history.push({
      patchSet: {
        ...input.patchSet,
        changes: input.patchSet.changes.map((change) => ({
          ...change,
          artifactRef: change.artifactRef,
        })),
      },
      toolName: input.toolName,
      appliedAt: Date.now(),
      status: "applied",
      changes: validated,
    });
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    this.persistHistory(sessionId);

    return {
      ok: true,
      patchSetId: input.patchSet.id,
      appliedPaths,
      failedPaths: [],
    };
  }

  rollbackLast(sessionId: string): RollbackResult {
    return this.rollbackPatchSet(sessionId);
  }

  rollbackPatchSet(sessionId: string, patchSetId?: string): RollbackResult {
    this.ensureHistoryLoaded(sessionId);
    const history = this.historyBySession.get(sessionId);
    const latest = this.findLatestUndoable(history);
    if (!latest) {
      return {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_patchset",
      };
    }
    const normalizedPatchSetId = patchSetId?.trim();
    if (normalizedPatchSetId && latest.patchSet.id !== normalizedPatchSetId) {
      return {
        ok: false,
        patchSetId: normalizedPatchSetId,
        restoredPaths: [],
        failedPaths: [],
        reason: "patchset_not_latest",
      };
    }

    const missingBeforeSnapshot = latest.changes.find(
      (change) =>
        change.beforeExists &&
        (!change.beforeSnapshotPath || !existsSync(change.beforeSnapshotPath)),
    );
    if (missingBeforeSnapshot) {
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths: [],
        failedPaths: [missingBeforeSnapshot.relativePath],
        reason: "restore_failed",
      };
    }

    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];
    const restoredChanges: AppliedChange[] = [];
    for (const change of latest.changes.toReversed()) {
      try {
        this.restoreBeforeChange(change);
        restoredPaths.push(change.relativePath);
        restoredChanges.push(change);
      } catch {
        failedPaths.push(change.relativePath);
      }
    }

    if (failedPaths.length > 0) {
      this.restoreAfterChanges(restoredChanges.toReversed());
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths,
        failedPaths,
        reason: "restore_failed",
      };
    }

    latest.status = "undone";
    latest.undoneAt = Date.now();
    this.persistHistory(sessionId);
    return {
      ok: true,
      patchSetId: latest.patchSet.id,
      restoredPaths,
      failedPaths: [],
    };
  }

  redoLast(sessionId: string): RedoResult {
    return this.redoPatchSet(sessionId);
  }

  redoPatchSet(sessionId: string, patchSetId?: string): RedoResult {
    this.ensureHistoryLoaded(sessionId);
    const history = this.historyBySession.get(sessionId);
    const latest = this.findNextRedoable(history);
    if (!latest) {
      return {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_undone_patchset",
      };
    }

    const normalizedPatchSetId = patchSetId?.trim();
    if (normalizedPatchSetId && latest.patchSet.id !== normalizedPatchSetId) {
      return {
        ok: false,
        patchSetId: normalizedPatchSetId,
        restoredPaths: [],
        failedPaths: [],
        reason: "patchset_not_latest",
      };
    }

    const mismatch = latest.changes.find((change) => {
      const currentExists = existsSync(change.absolutePath);
      if (change.beforeExists !== currentExists) {
        return true;
      }
      if (!currentExists) {
        return false;
      }
      return sha256(readFileSync(change.absolutePath)) !== change.beforeHash;
    });
    if (mismatch) {
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths: [],
        failedPaths: [mismatch.relativePath],
        reason: "current_state_mismatch",
      };
    }

    const missingAfterSnapshot = latest.changes.find(
      (change) =>
        change.afterExists && (!change.afterSnapshotPath || !existsSync(change.afterSnapshotPath)),
    );
    if (missingAfterSnapshot) {
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths: [],
        failedPaths: [missingAfterSnapshot.relativePath],
        reason: "missing_redo_snapshot",
      };
    }

    const restoredPaths: string[] = [];
    const failedPaths: string[] = [];
    const restoredChanges: AppliedChange[] = [];
    for (const change of latest.changes) {
      try {
        this.restoreAfterChange(change);
        restoredPaths.push(change.relativePath);
        restoredChanges.push(change);
      } catch {
        failedPaths.push(change.relativePath);
      }
    }

    if (failedPaths.length > 0) {
      this.restoreBeforeChanges(restoredChanges.toReversed());
      return {
        ok: false,
        patchSetId: latest.patchSet.id,
        restoredPaths,
        failedPaths,
        reason: "restore_failed",
      };
    }

    latest.status = "redone";
    latest.redoneAt = Date.now();
    this.persistHistory(sessionId);
    return {
      ok: true,
      patchSetId: latest.patchSet.id,
      restoredPaths,
      failedPaths: [],
    };
  }

  hasHistory(sessionId: string): boolean {
    this.ensureHistoryLoaded(sessionId);
    return this.findLatestUndoable(this.historyBySession.get(sessionId)) !== undefined;
  }

  recentFiles(sessionId: string, limit = 3): string[] {
    const max = Math.max(0, Math.floor(limit));
    if (max <= 0) return [];

    this.ensureHistoryLoaded(sessionId);
    const history = this.historyBySession.get(sessionId) ?? [];
    if (history.length === 0) return [];

    const selected: string[] = [];
    const seen = new Set<string>();

    for (const entry of history.toReversed()) {
      if (entry.status === "undone") continue;
      for (const change of entry.patchSet.changes) {
        const path = change.path;
        if (!path) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        selected.push(path);
        if (selected.length >= max) return selected;
      }
    }

    return selected;
  }

  latestSessionWithHistory(): string | undefined {
    const candidates: Array<{ sessionId: string; updatedAt: number }> = [];
    if (!existsSync(this.snapshotsDir)) return undefined;

    for (const entry of readdirSync(this.snapshotsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const historyFile = resolve(this.snapshotsDir, entry.name, PATCH_HISTORY_FILE);
      if (!existsSync(historyFile)) continue;
      const parsed = readPersistedPatchHistory(historyFile);
      if (!parsed) {
        continue;
      }
      const updatedAt = parsed.updatedAt || statSync(historyFile).mtimeMs;
      if (parsed.patchSets.some((patchSet) => patchSet.status !== "undone")) {
        candidates.push({ sessionId: parsed.sessionId, updatedAt });
      }
    }

    return candidates.toSorted((left, right) => right.updatedAt - left.updatedAt)[0]?.sessionId;
  }

  importSessionHistory(
    sourceSessionId: string,
    targetSessionId: string,
  ): { importedPatchSets: number } {
    if (sourceSessionId === targetSessionId) {
      return { importedPatchSets: 0 };
    }

    this.ensureHistoryLoaded(sourceSessionId);
    this.ensureHistoryLoaded(targetSessionId);

    const sourceHistory = this.historyBySession.get(sourceSessionId) ?? [];
    if (sourceHistory.length === 0) {
      return { importedPatchSets: 0 };
    }

    const sourceDir = this.sessionDir(sourceSessionId);
    const targetDir = this.sessionDir(targetSessionId);
    ensureDir(targetDir);

    const targetHistory = this.getOrCreateHistory(targetSessionId);
    const existingIds = new Set(targetHistory.map((item) => item.patchSet.id));
    const imported: AppliedMutation[] = [];

    for (const entry of sourceHistory) {
      if (existingIds.has(entry.patchSet.id)) {
        continue;
      }

      const changes = entry.changes.map((change) => {
        let beforeSnapshotPath: string | undefined;
        if (change.beforeSnapshotPath) {
          const snapshotFile = snapshotFileName(change.beforeSnapshotPath);
          const sourceSnapshotPath = resolve(sourceDir, snapshotFile);
          const fallbackSnapshotPath = change.beforeSnapshotPath;
          const selectedSourcePath = existsSync(sourceSnapshotPath)
            ? sourceSnapshotPath
            : existsSync(fallbackSnapshotPath)
              ? fallbackSnapshotPath
              : undefined;

          if (selectedSourcePath) {
            const targetSnapshotPath = resolve(targetDir, snapshotFile);
            if (!existsSync(targetSnapshotPath)) {
              writeFileAtomic(targetSnapshotPath, readFileSync(selectedSourcePath));
            }
            beforeSnapshotPath = targetSnapshotPath;
          }
        }

        let afterSnapshotPath: string | undefined;
        if (change.afterSnapshotPath) {
          const snapshotFile = snapshotFileName(change.afterSnapshotPath);
          const sourceSnapshotPath = resolve(sourceDir, snapshotFile);
          const fallbackSnapshotPath = change.afterSnapshotPath;
          const selectedSourcePath = existsSync(sourceSnapshotPath)
            ? sourceSnapshotPath
            : existsSync(fallbackSnapshotPath)
              ? fallbackSnapshotPath
              : undefined;

          if (selectedSourcePath) {
            const targetSnapshotPath = resolve(targetDir, snapshotFile);
            if (!existsSync(targetSnapshotPath)) {
              writeFileAtomic(targetSnapshotPath, readFileSync(selectedSourcePath));
            }
            afterSnapshotPath = targetSnapshotPath;
          }
        }

        return {
          ...change,
          beforeSnapshotPath,
          afterSnapshotPath,
        };
      });

      imported.push({
        patchSet: {
          ...entry.patchSet,
          changes: changes.map((change) => ({
            path: change.relativePath,
            action: change.action,
            beforeHash: change.beforeHash,
            afterHash: change.afterHash,
            artifactRef: entry.patchSet.changes.find(
              (patchChange) => patchChange.path === change.relativePath,
            )?.artifactRef,
          })),
        },
        toolName: entry.toolName,
        appliedAt: entry.appliedAt,
        status: entry.status,
        undoneAt: entry.undoneAt,
        redoneAt: entry.redoneAt,
        changes,
      });
    }

    if (imported.length === 0) {
      return { importedPatchSets: 0 };
    }

    const merged = [...targetHistory, ...imported].toSorted(
      (left, right) => left.appliedAt - right.appliedAt,
    );
    const trimmed = merged.slice(-MAX_HISTORY);
    this.historyBySession.set(targetSessionId, trimmed);
    this.persistHistory(targetSessionId);
    return { importedPatchSets: imported.length };
  }

  clearSession(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    this.historyBySession.delete(sessionId);
    this.loadedSessions.delete(sessionId);
  }

  private restoreBeforeChanges(changes: readonly AppliedChange[]): void {
    for (const change of changes) {
      try {
        this.restoreBeforeChange(change);
      } catch {
        // Best-effort cleanup only; the primary failure remains the operation result.
      }
    }
  }

  private restoreBeforeChange(change: AppliedChange): void {
    if (change.beforeExists) {
      if (!change.beforeSnapshotPath || !existsSync(change.beforeSnapshotPath)) {
        throw new Error(`Missing snapshot for ${change.relativePath}`);
      }
      writeFileAtomic(change.absolutePath, readFileSync(change.beforeSnapshotPath));
      return;
    }
    if (existsSync(change.absolutePath)) {
      rmSync(change.absolutePath, { force: true });
    }
  }

  private restoreAfterChanges(changes: readonly AppliedChange[]): void {
    for (const change of changes) {
      try {
        this.restoreAfterChange(change);
      } catch {
        // Best-effort cleanup only; the primary failure remains the operation result.
      }
    }
  }

  private restoreAfterChange(change: AppliedChange): void {
    if (!change.afterExists) {
      if (existsSync(change.absolutePath)) {
        rmSync(change.absolutePath, { force: true });
      }
      return;
    }
    if (!change.afterSnapshotPath || !existsSync(change.afterSnapshotPath)) {
      throw new Error(`Missing redo snapshot for ${change.relativePath}`);
    }
    writeFileAtomic(change.absolutePath, readFileSync(change.afterSnapshotPath));
  }

  private captureFileSnapshot(
    sessionId: string,
    absolutePath: string,
    relativePath: string,
  ): TrackedFileState {
    const beforeExists = existsSync(absolutePath);
    if (!beforeExists) {
      return {
        absolutePath,
        relativePath,
        beforeExists: false,
      };
    }

    const content = readFileSync(absolutePath);
    const beforeHash = sha256(content);
    const beforeSnapshotPath = this.writeFileSnapshot(sessionId, relativePath, content);

    return {
      absolutePath,
      relativePath,
      beforeExists: true,
      beforeHash,
      beforeSnapshotPath,
    };
  }

  private writeFileSnapshot(sessionId: string, relativePath: string, content: Buffer): string {
    const sessionDir = this.sessionDir(sessionId);
    ensureDir(sessionDir);

    const snapshotId = sha256(`${relativePath}:${sha256(content)}`);
    const snapshotPath = resolve(sessionDir, `${snapshotId}.snap`);
    if (!existsSync(snapshotPath)) {
      writeFileAtomic(snapshotPath, content);
    }
    return snapshotPath;
  }

  private resolveAction(input: {
    beforeExists: boolean;
    afterExists: boolean;
    beforeHash?: string;
    afterHash?: string;
  }): PatchFileAction | undefined {
    if (!input.beforeExists && input.afterExists) return "add";
    if (input.beforeExists && !input.afterExists) return "delete";
    if (input.beforeExists && input.afterExists && input.beforeHash !== input.afterHash)
      return "modify";
    return undefined;
  }

  private getOrCreatePending(sessionId: string): Map<string, PendingMutation> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) return existing;
    const pending = new Map<string, PendingMutation>();
    this.pendingBySession.set(sessionId, pending);
    return pending;
  }

  private getOrCreateHistory(sessionId: string): AppliedMutation[] {
    const existing = this.historyBySession.get(sessionId);
    if (existing) return existing;
    const history: AppliedMutation[] = [];
    this.historyBySession.set(sessionId, history);
    return history;
  }

  private findLatestUndoable(history: AppliedMutation[] | undefined): AppliedMutation | undefined {
    return history?.toReversed().find((entry) => entry.status !== "undone");
  }

  private findNextRedoable(history: AppliedMutation[] | undefined): AppliedMutation | undefined {
    return history?.find((entry) => entry.status === "undone");
  }

  private ensureHistoryLoaded(sessionId: string): void {
    if (this.loadedSessions.has(sessionId)) {
      return;
    }
    this.loadedSessions.add(sessionId);

    const historyPath = this.historyPath(sessionId);
    if (!existsSync(historyPath)) {
      this.historyBySession.set(sessionId, []);
      return;
    }

    const parsed = readPersistedPatchHistory(historyPath);
    if (!parsed || parsed.sessionId !== sessionId) {
      this.historyBySession.set(sessionId, []);
      return;
    }

    try {
      const history: AppliedMutation[] = [];
      for (const entry of parsed.patchSets) {
        const changes = entry.changes.map((change) => {
          const absolutePath = resolve(this.cwd, change.path);
          const beforeSnapshotPath = change.beforeSnapshotFile
            ? resolve(this.sessionDir(sessionId), change.beforeSnapshotFile)
            : undefined;
          const afterSnapshotPath = change.afterSnapshotFile
            ? resolve(this.sessionDir(sessionId), change.afterSnapshotFile)
            : undefined;
          return {
            absolutePath,
            relativePath: normalizeWorkspaceRelativePath(change.path),
            beforeExists: change.beforeExists ?? false,
            beforeHash: change.beforeHash,
            beforeSnapshotPath,
            action: change.action,
            afterExists: change.action !== "delete",
            afterHash: change.afterHash,
            afterSnapshotPath,
          };
        });

        history.push({
          patchSet: {
            id: entry.id,
            createdAt: entry.createdAt,
            summary: entry.summary,
            changes: entry.changes.map((change) => ({
              path: change.path,
              action: change.action,
              beforeHash: change.beforeHash,
              afterHash: change.afterHash,
              artifactRef: change.artifactRef,
            })),
          },
          toolName: entry.toolName,
          appliedAt: entry.appliedAt,
          status: entry.status,
          undoneAt: entry.undoneAt,
          redoneAt: entry.redoneAt,
          changes,
        });
      }
      this.historyBySession.set(sessionId, history.slice(-MAX_HISTORY));
    } catch {
      this.historyBySession.set(sessionId, []);
    }
  }

  private persistHistory(sessionId: string): void {
    const history = this.historyBySession.get(sessionId) ?? [];
    const payload: PersistedPatchHistory = {
      version: 1,
      sessionId,
      updatedAt: Date.now(),
      patchSets: history.map((item) => ({
        id: item.patchSet.id,
        createdAt: item.patchSet.createdAt,
        summary: item.patchSet.summary,
        toolName: item.toolName,
        appliedAt: item.appliedAt,
        status: item.status,
        undoneAt: item.undoneAt,
        redoneAt: item.redoneAt,
        changes: item.changes.map((change) => ({
          path: change.relativePath,
          action: change.action,
          beforeExists: change.beforeExists,
          beforeHash: change.beforeHash,
          afterHash: change.afterHash,
          beforeSnapshotFile: change.beforeSnapshotPath
            ? snapshotFileName(change.beforeSnapshotPath)
            : undefined,
          afterSnapshotFile: change.afterSnapshotPath
            ? snapshotFileName(change.afterSnapshotPath)
            : undefined,
          artifactRef: item.patchSet.changes.find(
            (patchChange) => patchChange.path === change.relativePath,
          )?.artifactRef,
        })),
      })),
    };
    writeFileAtomic(this.historyPath(sessionId), JSON.stringify(payload, null, 2));
  }

  private sessionDir(sessionId: string): string {
    return resolve(this.snapshotsDir, sanitizeSessionId(sessionId));
  }

  private historyPath(sessionId: string): string {
    return resolve(this.sessionDir(sessionId), PATCH_HISTORY_FILE);
  }
}
