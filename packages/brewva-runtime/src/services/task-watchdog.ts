import type { BrewvaEventQuery, BrewvaEventRecord, TaskState } from "../contracts/index.js";
import {
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { TASK_EVENT_TYPE } from "../task/ledger.js";
import {
  buildTaskStuckClearedPayload,
  buildTaskStuckDetectedPayload,
  coerceTaskStuckDetectedPayload,
  computeTaskSemanticProgressAt,
  evaluateTaskWatchdogEligibility,
  getTaskWatchdogOpenItemCount,
  toTaskWatchdogEventPayload,
} from "../task/watchdog.js";

const DEFAULT_THRESHOLD_MS = 5 * 60_000;

function sanitizeDelayMs(value: number | undefined, fallbackMs: number): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallbackMs;
  return Math.max(1_000, candidate);
}

export interface PollTaskProgressInput {
  sessionId: string;
  now?: number;
  thresholdMs?: number;
}

export interface TaskWatchdogServiceOptions {
  listEvents: (sessionId: string, query?: BrewvaEventQuery) => BrewvaEventRecord[];
  getTaskState: RuntimeKernelContext["getTaskState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

export class TaskWatchdogService {
  private readonly listEvents: TaskWatchdogServiceOptions["listEvents"];
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];

  constructor(options: TaskWatchdogServiceOptions) {
    this.listEvents = (sessionId, query) => options.listEvents(sessionId, query);
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  onTurnStart(sessionId: string): void {
    this.maybeClearTaskProgressStall(sessionId);
  }

  pollTaskProgress(input: PollTaskProgressInput): void {
    const taskState = this.getTaskState(input.sessionId);
    const eligibility = evaluateTaskWatchdogEligibility(taskState);
    if (!eligibility.eligible) {
      return;
    }

    const taskEvents = this.listEvents(input.sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(input.sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const baselineProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (baselineProgressAt === null) {
      return;
    }

    const thresholdMs = sanitizeDelayMs(input.thresholdMs, DEFAULT_THRESHOLD_MS);
    const detectedAt = input.now ?? Date.now();
    const idleMs = Math.max(0, detectedAt - baselineProgressAt);
    if (idleMs < thresholdMs) {
      return;
    }

    const latestDetected = this.listEvents(input.sessionId, {
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      last: 1,
    })[0];
    const latestClearedAt =
      this.listEvents(input.sessionId, {
        type: TASK_STUCK_CLEARED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? 0;
    const latestPayload = coerceTaskStuckDetectedPayload(latestDetected?.payload);
    if (
      latestPayload &&
      latestDetected &&
      latestDetected.timestamp > latestClearedAt &&
      latestPayload.baselineProgressAt === baselineProgressAt &&
      latestPayload.thresholdMs === thresholdMs
    ) {
      return;
    }

    const detectedPayload = buildTaskStuckDetectedPayload({
      thresholdMs,
      baselineProgressAt,
      detectedAt,
      idleMs,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
    });

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      timestamp: detectedAt,
      turn: this.getCurrentTurn(input.sessionId),
      payload: toTaskWatchdogEventPayload(detectedPayload),
    });
  }

  private maybeClearTaskProgressStall(sessionId: string): void {
    const taskState = this.getTaskState(sessionId);
    const latestDetected = this.listEvents(sessionId, {
      type: TASK_STUCK_DETECTED_EVENT_TYPE,
      last: 1,
    })[0];
    const detectedPayload = coerceTaskStuckDetectedPayload(latestDetected?.payload);
    if (!latestDetected || !detectedPayload) {
      return;
    }

    const latestClearedAt =
      this.listEvents(sessionId, {
        type: TASK_STUCK_CLEARED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? 0;
    if (latestDetected.timestamp <= latestClearedAt) {
      return;
    }

    const taskEvents = this.listEvents(sessionId, { type: TASK_EVENT_TYPE });
    const lastVerificationAt =
      this.listEvents(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0]?.timestamp ?? null;
    const semanticProgressAt = computeTaskSemanticProgressAt({
      state: taskState,
      taskEvents,
      lastVerificationAt,
    });
    if (semanticProgressAt === null || semanticProgressAt <= detectedPayload.baselineProgressAt) {
      return;
    }
    const clearedAt = Date.now();
    const clearedPayload = buildTaskStuckClearedPayload({
      detectedAt: detectedPayload.detectedAt,
      clearedAt,
      resumedProgressAt: semanticProgressAt,
      openItemCount: getTaskWatchdogOpenItemCount(taskState),
    });

    this.recordEvent({
      sessionId,
      type: TASK_STUCK_CLEARED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      timestamp: clearedAt,
      payload: toTaskWatchdogEventPayload(clearedPayload),
    });
  }
}
