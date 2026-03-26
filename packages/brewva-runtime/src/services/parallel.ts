import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BrewvaEventRecord,
  ParallelAcquireResult,
  PatchSet,
  SkillDocument,
  WorkerApplyReport,
  WorkerMergeReport,
  WorkerResult,
} from "../contracts/index.js";
import {
  SUBAGENT_CANCELLED_EVENT_TYPE,
  SUBAGENT_COMPLETED_EVENT_TYPE,
  SUBAGENT_FAILED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "../events/event-types.js";
import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import type { FileChangeService } from "./file-change.js";
import type { ResourceLeaseService } from "./resource-lease.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface ParallelServiceOptions {
  workspaceRoot: string;
  securityConfig: RuntimeKernelContext["config"]["security"];
  parallel: RuntimeKernelContext["parallel"];
  parallelResults: RuntimeKernelContext["parallelResults"];
  sessionState: RuntimeKernelContext["sessionState"];
  eventStore: RuntimeKernelContext["eventStore"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  fileChangeService: Pick<FileChangeService, "applyPatchSet">;
  resourceLeaseService: Pick<ResourceLeaseService, "getEffectiveBudget">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readArtifactRefPath(
  payload: Record<string, unknown> | undefined,
  kind: string,
): string | undefined {
  if (!Array.isArray(payload?.artifactRefs)) {
    return undefined;
  }
  for (const entry of payload.artifactRefs) {
    if (!isRecord(entry)) {
      continue;
    }
    if (readString(entry.kind) !== kind) {
      continue;
    }
    const path = readString(entry.path);
    if (path) {
      return path;
    }
  }
  return undefined;
}

function readPatchSetManifest(workspaceRoot: string, pathRef: string): PatchSet | undefined {
  const filePath = resolve(workspaceRoot, pathRef);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.changes)) {
      return undefined;
    }
    return parsed as unknown as PatchSet;
  } catch {
    return undefined;
  }
}

function buildRecoveredWorkerResult(
  workspaceRoot: string,
  event: BrewvaEventRecord,
): WorkerResult | undefined {
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const workerId = readString(payload?.runId);
  if (!workerId) {
    return undefined;
  }
  const kind = readString(payload?.kind);
  const manifestRef = readArtifactRefPath(payload, "patch_manifest");
  if (kind !== "patch" && !manifestRef) {
    return undefined;
  }

  if (event.type === SUBAGENT_COMPLETED_EVENT_TYPE) {
    const patches = manifestRef ? readPatchSetManifest(workspaceRoot, manifestRef) : undefined;
    return {
      workerId,
      status: patches ? "ok" : "skipped",
      summary: readString(payload?.summary) ?? "Recovered delegated patch outcome.",
      patches,
    };
  }

  if (event.type !== SUBAGENT_FAILED_EVENT_TYPE && event.type !== SUBAGENT_CANCELLED_EVENT_TYPE) {
    return undefined;
  }

  return {
    workerId,
    status: "error",
    summary:
      readString(payload?.summary) ??
      readString(payload?.error) ??
      readString(payload?.reason) ??
      "Recovered delegated patch failure.",
    errorMessage:
      readString(payload?.error) ??
      readString(payload?.reason) ??
      "Recovered delegated patch failure.",
  };
}

function recoverWorkerResultsFromEvents(
  sessionId: string,
  workspaceRoot: string,
  events: BrewvaEventRecord[],
): WorkerResult[] {
  const recovered = new Map<string, WorkerResult>();
  for (const event of events) {
    if (event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE) {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const workerIds = Array.isArray(payload?.workerIds)
        ? payload.workerIds.flatMap((value) =>
            typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [],
          )
        : [];
      for (const workerId of workerIds) {
        recovered.delete(workerId);
      }
      continue;
    }

    if (
      event.type !== SUBAGENT_COMPLETED_EVENT_TYPE &&
      event.type !== SUBAGENT_FAILED_EVENT_TYPE &&
      event.type !== SUBAGENT_CANCELLED_EVENT_TYPE
    ) {
      continue;
    }

    const recoveredResult = buildRecoveredWorkerResult(workspaceRoot, event);
    if (!recoveredResult) {
      continue;
    }
    recovered.set(recoveredResult.workerId, recoveredResult);
  }
  return [...recovered.values()];
}

export function hydrateAndListWorkerResults(input: {
  sessionId: string;
  workspaceRoot: string;
  eventStore: RuntimeKernelContext["eventStore"];
  parallelResults: ParallelResultStore;
}): WorkerResult[] {
  const existingWorkerIds = new Set(
    input.parallelResults.list(input.sessionId).map((result) => result.workerId),
  );
  const recoveredResults = recoverWorkerResultsFromEvents(
    input.sessionId,
    input.workspaceRoot,
    input.eventStore.list(input.sessionId),
  );
  for (const recovered of recoveredResults) {
    if (existingWorkerIds.has(recovered.workerId)) {
      continue;
    }
    input.parallelResults.record(input.sessionId, recovered);
  }
  return input.parallelResults.list(input.sessionId);
}

export class ParallelService {
  private readonly securityPolicy: ReturnType<typeof resolveSecurityPolicy>;
  private readonly workspaceRoot: string;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly eventStore: RuntimeKernelContext["eventStore"];
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getEffectiveBudget: ResourceLeaseService["getEffectiveBudget"];
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;
  private readonly applyPatchSet: FileChangeService["applyPatchSet"];

  constructor(options: ParallelServiceOptions) {
    this.securityPolicy = resolveSecurityPolicy(options.securityConfig);
    this.workspaceRoot = options.workspaceRoot;
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.sessionState = options.sessionState;
    this.eventStore = options.eventStore;
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getEffectiveBudget = (sessionId, contract, skillName) =>
      options.resourceLeaseService.getEffectiveBudget(sessionId, contract, skillName);
    this.recordEvent = (input) => options.recordEvent(input);
    this.applyPatchSet = (input) => options.fileChangeService.applyPatchSet(input);
  }

  acquireParallelSlot(sessionId: string, runId: string): ParallelAcquireResult {
    return this.tryAcquireParallelSlot(sessionId, runId, { recordRejection: true });
  }

  async acquireParallelSlotAsync(
    sessionId: string,
    runId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<ParallelAcquireResult> {
    const immediate = this.tryAcquireParallelSlot(sessionId, runId, { recordRejection: false });
    if (immediate.accepted || immediate.reason !== "max_concurrent") {
      if (!immediate.accepted) {
        this.recordParallelRejection(sessionId, runId, immediate.reason);
      }
      return immediate;
    }

    const acquired = await this.parallel.acquireAsync(sessionId, runId, options);
    if (!acquired.accepted) {
      this.recordParallelRejection(sessionId, runId, acquired.reason);
    }
    return acquired;
  }

  releaseParallelSlot(sessionId: string, runId: string): void {
    this.parallel.release(sessionId, runId);
  }

  recordWorkerResult(sessionId: string, result: WorkerResult): void {
    this.parallelResults.record(sessionId, result);
    this.parallel.release(sessionId, result.workerId);
  }

  listWorkerResults(sessionId: string): WorkerResult[] {
    return hydrateAndListWorkerResults({
      sessionId,
      workspaceRoot: this.workspaceRoot,
      eventStore: this.eventStore,
      parallelResults: this.parallelResults,
    });
  }

  mergeWorkerResults(sessionId: string): WorkerMergeReport {
    hydrateAndListWorkerResults({
      sessionId,
      workspaceRoot: this.workspaceRoot,
      eventStore: this.eventStore,
      parallelResults: this.parallelResults,
    });
    return this.parallelResults.merge(sessionId);
  }

  applyMergedWorkerResults(
    sessionId: string,
    input: {
      toolName: string;
      toolCallId?: string;
    },
  ): WorkerApplyReport {
    hydrateAndListWorkerResults({
      sessionId,
      workspaceRoot: this.workspaceRoot,
      eventStore: this.eventStore,
      parallelResults: this.parallelResults,
    });
    const merged = this.parallelResults.merge(sessionId);
    if (merged.status === "empty") {
      this.recordEvent({
        sessionId,
        type: "worker_results_apply_failed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          reason: "empty_patchset",
          workerIds: merged.workerIds,
          conflicts: [],
        },
      });
      return {
        status: "empty",
        workerIds: merged.workerIds,
        conflicts: [],
        appliedPaths: [],
        failedPaths: [],
        reason: "empty_patchset",
      };
    }

    if (merged.status === "conflicts" || !merged.mergedPatchSet) {
      this.recordEvent({
        sessionId,
        type: "worker_results_apply_failed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          reason: "merge_conflicts",
          workerIds: merged.workerIds,
          conflicts: merged.conflicts.map((conflict) => ({
            path: conflict.path,
            workerIds: conflict.workerIds,
            patchSetIds: conflict.patchSetIds,
          })),
        },
      });
      return {
        status: "conflicts",
        workerIds: merged.workerIds,
        conflicts: merged.conflicts,
        mergedPatchSet: merged.mergedPatchSet,
        appliedPaths: [],
        failedPaths: [],
      };
    }

    const applied = this.applyPatchSet({
      sessionId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      patchSet: merged.mergedPatchSet,
    });
    if (!applied.ok) {
      this.recordEvent({
        sessionId,
        type: "worker_results_apply_failed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          reason: applied.reason ?? "write_failed",
          workerIds: merged.workerIds,
          patchSetId: applied.patchSetId ?? null,
          failedPaths: applied.failedPaths,
        },
      });
      return {
        status: "apply_failed",
        workerIds: merged.workerIds,
        conflicts: [],
        mergedPatchSet: merged.mergedPatchSet,
        appliedPatchSetId: applied.patchSetId,
        appliedPaths: [],
        failedPaths: applied.failedPaths,
        reason: applied.reason,
      };
    }

    this.parallelResults.clear(sessionId);
    this.recordEvent({
      sessionId,
      type: "worker_results_applied",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        workerIds: merged.workerIds,
        patchSetId: applied.patchSetId ?? null,
        appliedPaths: applied.appliedPaths,
      },
    });
    return {
      status: "applied",
      workerIds: merged.workerIds,
      conflicts: [],
      mergedPatchSet: merged.mergedPatchSet,
      appliedPatchSetId: applied.patchSetId,
      appliedPaths: applied.appliedPaths,
      failedPaths: [],
    };
  }

  clearWorkerResults(sessionId: string): void {
    this.parallelResults.clear(sessionId);
  }

  private tryAcquireParallelSlot(
    sessionId: string,
    runId: string,
    options: { recordRejection: boolean },
  ): ParallelAcquireResult {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const effectiveBudget =
      skill?.contract !== undefined
        ? this.getEffectiveBudget(sessionId, skill.contract, skill.name)
        : undefined;
    const maxParallel = effectiveBudget?.maxParallel;

    if (
      skill &&
      typeof maxParallel === "number" &&
      maxParallel > 0 &&
      this.securityPolicy.skillMaxParallelMode !== "off"
    ) {
      const activeRuns = this.parallel.getActiveRunCount(sessionId);
      if (activeRuns >= maxParallel) {
        const mode = this.securityPolicy.skillMaxParallelMode;
        if (mode === "warn") {
          const key = `maxParallel:${skill.name}`;
          const seen = state.skillParallelWarnings;
          if (!seen.has(key)) {
            seen.add(key);
            this.recordEvent({
              sessionId,
              type: "skill_parallel_warning",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                skill: skill.name,
                activeRuns,
                maxParallel,
                mode,
              },
            });
          }
        } else if (mode === "enforce") {
          if (options.recordRejection) {
            this.recordEvent({
              sessionId,
              type: "parallel_slot_rejected",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                runId,
                skill: skill.name,
                reason: "skill_max_parallel",
                activeRuns,
                maxParallel,
              },
            });
          }
          return { accepted: false, reason: "skill_max_parallel" };
        }
      }
    }

    const acquired = this.parallel.acquire(sessionId, runId);
    if (!acquired.accepted && options.recordRejection) {
      this.recordParallelRejection(sessionId, runId, acquired.reason, skill?.name);
    }
    return acquired;
  }

  private recordParallelRejection(
    sessionId: string,
    runId: string,
    reason: ParallelAcquireResult["reason"],
    skillName?: string,
  ): void {
    this.recordEvent({
      sessionId,
      type: "parallel_slot_rejected",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        runId,
        skill: skillName ?? this.getActiveSkill(sessionId)?.name ?? null,
        reason: reason ?? "unknown",
      },
    });
  }
}
