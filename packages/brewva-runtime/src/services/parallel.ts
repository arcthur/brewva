import type { ParallelBudgetManager } from "../parallel/budget.js";
import type { ParallelResultStore } from "../parallel/results.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import type {
  BrewvaConfig,
  ParallelAcquireResult,
  SkillDocument,
  WorkerMergeReport,
  WorkerResult,
} from "../types.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

export interface ParallelServiceOptions {
  securityConfig: BrewvaConfig["security"];
  parallel: ParallelBudgetManager;
  parallelResults: ParallelResultStore;
  sessionState: RuntimeSessionStateStore;
  getActiveSkill: RuntimeCallback<[sessionId: string], SkillDocument | undefined>;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
}

export class ParallelService {
  private readonly securityPolicy: ReturnType<typeof resolveSecurityPolicy>;
  private readonly parallel: ParallelBudgetManager;
  private readonly parallelResults: ParallelResultStore;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: ParallelServiceOptions["recordEvent"];

  constructor(options: ParallelServiceOptions) {
    this.securityPolicy = resolveSecurityPolicy(options.securityConfig);
    this.parallel = options.parallel;
    this.parallelResults = options.parallelResults;
    this.sessionState = options.sessionState;
    this.getActiveSkill = options.getActiveSkill;
    this.getCurrentTurn = options.getCurrentTurn;
    this.recordEvent = options.recordEvent;
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
    return this.parallelResults.list(sessionId);
  }

  mergeWorkerResults(sessionId: string): WorkerMergeReport {
    return this.parallelResults.merge(sessionId);
  }

  clearWorkerResults(sessionId: string): void {
    this.parallelResults.clear(sessionId);
  }

  private tryAcquireParallelSlot(
    sessionId: string,
    runId: string,
    options: { recordRejection: boolean },
  ): ParallelAcquireResult {
    const skill = this.getActiveSkill(sessionId);
    const maxParallel = skill?.contract.maxParallel;

    if (
      skill &&
      typeof maxParallel === "number" &&
      maxParallel > 0 &&
      this.securityPolicy.skillMaxParallelMode !== "off"
    ) {
      const activeRuns = this.parallel.snapshotSession(sessionId)?.activeRunIds.length ?? 0;
      if (activeRuns >= maxParallel) {
        const mode = this.securityPolicy.skillMaxParallelMode;
        if (mode === "warn") {
          const key = `maxParallel:${skill.name}`;
          const seen =
            this.sessionState.skillParallelWarningsBySession.get(sessionId) ?? new Set<string>();
          if (!seen.has(key)) {
            seen.add(key);
            this.sessionState.skillParallelWarningsBySession.set(sessionId, seen);
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
