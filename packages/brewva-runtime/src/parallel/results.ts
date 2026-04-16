import type {
  PatchConflict,
  PatchFileChange,
  PatchSet,
  WorkerMergeReport,
  WorkerResult,
} from "../contracts/index.js";

interface PatchOrigin {
  workerId: string;
  patchSetId: string;
  change: PatchFileChange;
}

function detectConflicts(origins: PatchOrigin[]): PatchConflict[] {
  const byPath = new Map<string, PatchOrigin[]>();
  for (const origin of origins) {
    const current = byPath.get(origin.change.path) ?? [];
    current.push(origin);
    byPath.set(origin.change.path, current);
  }

  const conflicts: PatchConflict[] = [];
  for (const [path, pathOrigins] of byPath.entries()) {
    const workerIds = [...new Set(pathOrigins.map((item) => item.workerId))];
    if (workerIds.length <= 1) continue;
    conflicts.push({
      path,
      workerIds,
      patchSetIds: [...new Set(pathOrigins.map((item) => item.patchSetId))],
    });
  }
  return conflicts;
}

function buildMergedPatchSet(origins: PatchOrigin[]): PatchSet {
  const byPath = new Map<string, PatchFileChange>();
  const orderedPaths: string[] = [];

  for (const origin of origins) {
    if (!byPath.has(origin.change.path)) {
      orderedPaths.push(origin.change.path);
    }
    byPath.set(origin.change.path, origin.change);
  }

  return {
    id: `merged_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
    summary: `Merged ${origins.length} patch fragments`,
    changes: orderedPaths.map((path) => byPath.get(path)!).filter(Boolean),
  };
}

export class ParallelResultStore {
  private readonly sessions = new Map<string, Map<string, WorkerResult>>();
  private readonly hydratedSessions = new Set<string>();

  record(sessionId: string, result: WorkerResult): void {
    const state = this.getOrCreate(sessionId);
    state.set(result.workerId, result);
  }

  replace(sessionId: string, results: readonly WorkerResult[]): void {
    const state = this.getOrCreate(sessionId);
    state.clear();
    for (const result of results) {
      state.set(result.workerId, result);
    }
  }

  delete(sessionId: string, workerId: string): void {
    this.sessions.get(sessionId)?.delete(workerId);
  }

  list(sessionId: string): WorkerResult[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return [...state.values()];
  }

  isHydrated(sessionId: string): boolean {
    return this.hydratedSessions.has(sessionId);
  }

  markHydrated(sessionId: string): void {
    this.hydratedSessions.add(sessionId);
  }

  clear(sessionId: string, options: { preserveHydration?: boolean } = {}): void {
    this.sessions.delete(sessionId);
    if (!options.preserveHydration) {
      this.hydratedSessions.delete(sessionId);
    }
  }

  merge(sessionId: string): WorkerMergeReport {
    const results = this.list(sessionId);
    const workerIds = results.map((result) => result.workerId);

    const origins: PatchOrigin[] = [];
    for (const result of results) {
      if (result.status !== "ok") continue;
      for (const change of result.patches.changes) {
        origins.push({
          workerId: result.workerId,
          patchSetId: result.patches.id,
          change,
        });
      }
    }

    if (origins.length === 0) {
      return {
        status: "empty",
        workerIds,
        conflicts: [],
      };
    }

    const conflicts = detectConflicts(origins);
    if (conflicts.length > 0) {
      return {
        status: "conflicts",
        workerIds,
        conflicts,
      };
    }

    return {
      status: "merged",
      workerIds,
      conflicts: [],
      mergedPatchSet: buildMergedPatchSet(origins),
    };
  }

  private getOrCreate(sessionId: string): Map<string, WorkerResult> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, WorkerResult>();
    this.sessions.set(sessionId, created);
    return created;
  }
}
