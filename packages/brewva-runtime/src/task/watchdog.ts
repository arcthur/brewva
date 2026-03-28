import type { TapePressureLevel } from "../contracts/context.js";
import type { BrewvaEventRecord, TaskState } from "../contracts/index.js";
import {
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "../events/event-types.js";
import { coerceTaskLedgerPayload } from "./ledger.js";

export const TASK_WATCHDOG_SCHEMA = "brewva.task-watchdog.v1" as const;
export const TASK_STALL_ADJUDICATION_SCHEMA = "brewva.task-stall-adjudication.v1" as const;

export interface TaskStuckDetectedPayload {
  schema: typeof TASK_WATCHDOG_SCHEMA;
  thresholdMs: number;
  baselineProgressAt: number;
  detectedAt: number;
  idleMs: number;
  openItemCount: number;
}

export interface TaskStuckClearedPayload {
  schema: typeof TASK_WATCHDOG_SCHEMA;
  detectedAt: number;
  clearedAt: number;
  resumedProgressAt: number;
  openItemCount: number;
}

export type TaskStallAdjudicationDecision =
  | "continue"
  | "nudge"
  | "compact_recommended"
  | "abort_recommended";

export interface TaskStallAdjudicatedPayload {
  schema: typeof TASK_STALL_ADJUDICATION_SCHEMA;
  detectedAt: number;
  baselineProgressAt: number;
  adjudicatedAt: number;
  decision: TaskStallAdjudicationDecision;
  source: "heuristic" | "hook";
  rationale: string;
  signalSummary: string[];
  tapePressure: TapePressureLevel;
  blockerCount: number;
  blockedToolCount: number;
  failureCount: number;
  pendingWorkerResults: number;
  verificationLastOutcome: "pass" | "fail" | "skipped" | null;
  verificationPassed: boolean;
  verificationSkipped: boolean;
}

export interface TaskWatchdogEligibility {
  eligible: boolean;
  reason?: "inactive_task";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function maxTimestamp(current: number | null, next: number | null | undefined): number | null {
  if (typeof next !== "number" || !Number.isFinite(next) || next <= 0) {
    return current;
  }
  return current === null ? next : Math.max(current, next);
}

function countOpenItems(state: TaskState): number {
  return state.items.filter((item) => item.status !== "done").length;
}

export function getTaskWatchdogOpenItemCount(state: TaskState): number {
  return countOpenItems(state);
}

export function evaluateTaskWatchdogEligibility(state: TaskState): TaskWatchdogEligibility {
  if (state.status?.phase === "done") {
    return {
      eligible: false,
      reason: "inactive_task",
    };
  }

  if (!state.spec && state.items.length === 0 && state.blockers.length === 0) {
    return {
      eligible: false,
      reason: "inactive_task",
    };
  }

  return {
    eligible: true,
  };
}

export function computeTaskSemanticProgressAt(input: {
  state: TaskState;
  taskEvents: BrewvaEventRecord[];
  lastVerificationAt?: number | null;
}): number | null {
  let latest: number | null = null;

  for (const item of input.state.items) {
    latest = maxTimestamp(latest, item.updatedAt);
  }

  for (const blocker of input.state.blockers) {
    latest = maxTimestamp(latest, blocker.createdAt);
  }

  latest = maxTimestamp(latest, input.lastVerificationAt ?? null);

  // Deliberately exclude status_set: task status can change from context/truth/budget
  // alignment without any task-ledger progress, and the watchdog should not reset on that.
  for (let index = input.taskEvents.length - 1; index >= 0; index -= 1) {
    const event = input.taskEvents[index];
    if (!event) continue;
    const payload = coerceTaskLedgerPayload(event.payload);
    if (!payload) continue;
    if (payload.kind === "spec_set") {
      latest = maxTimestamp(latest, event.timestamp);
      break;
    }
    if (payload.kind === "blocker_resolved") {
      latest = maxTimestamp(latest, event.timestamp);
      break;
    }
    if (payload.kind === "acceptance_set") {
      latest = maxTimestamp(latest, event.timestamp);
      break;
    }
  }

  if (latest !== null) {
    return latest;
  }

  return typeof input.state.updatedAt === "number" && Number.isFinite(input.state.updatedAt)
    ? input.state.updatedAt
    : null;
}

export function buildTaskStuckDetectedPayload(
  input: Omit<TaskStuckDetectedPayload, "schema">,
): TaskStuckDetectedPayload {
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    ...input,
  };
}

export function buildTaskStuckClearedPayload(
  input: Omit<TaskStuckClearedPayload, "schema">,
): TaskStuckClearedPayload {
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    ...input,
  };
}

export function buildTaskStallAdjudicatedPayload(
  input: Omit<TaskStallAdjudicatedPayload, "schema">,
): TaskStallAdjudicatedPayload {
  return {
    schema: TASK_STALL_ADJUDICATION_SCHEMA,
    ...input,
  };
}

export function toTaskWatchdogEventPayload(
  payload: TaskStuckDetectedPayload | TaskStuckClearedPayload | TaskStallAdjudicatedPayload,
): Record<string, unknown> {
  return { ...payload };
}

export function coerceTaskStuckDetectedPayload(value: unknown): TaskStuckDetectedPayload | null {
  if (!isRecord(value) || value.schema !== TASK_WATCHDOG_SCHEMA) {
    return null;
  }
  const thresholdMs = Number(value.thresholdMs);
  const baselineProgressAt = Number(value.baselineProgressAt);
  const detectedAt = Number(value.detectedAt);
  const idleMs = Number(value.idleMs);
  const openItemCount = Number(value.openItemCount);
  if (
    !Number.isFinite(thresholdMs) ||
    !Number.isFinite(baselineProgressAt) ||
    !Number.isFinite(detectedAt) ||
    !Number.isFinite(idleMs) ||
    !Number.isFinite(openItemCount)
  ) {
    return null;
  }
  return {
    schema: TASK_WATCHDOG_SCHEMA,
    thresholdMs,
    baselineProgressAt,
    detectedAt,
    idleMs,
    openItemCount,
  };
}

export function coerceTaskStallAdjudicatedPayload(
  value: unknown,
): TaskStallAdjudicatedPayload | null {
  if (!isRecord(value) || value.schema !== TASK_STALL_ADJUDICATION_SCHEMA) {
    return null;
  }
  const detectedAt = Number(value.detectedAt);
  const baselineProgressAt = Number(value.baselineProgressAt);
  const adjudicatedAt = Number(value.adjudicatedAt);
  const decision = value.decision;
  const source = value.source;
  const rationale = typeof value.rationale === "string" ? value.rationale : null;
  const signalSummary = Array.isArray(value.signalSummary)
    ? value.signalSummary.filter((entry): entry is string => typeof entry === "string")
    : null;
  const tapePressure = value.tapePressure;
  const blockerCount = Number(value.blockerCount);
  const blockedToolCount = Number(value.blockedToolCount);
  const failureCount = Number(value.failureCount);
  const pendingWorkerResults = Number(value.pendingWorkerResults);
  const verificationLastOutcome = value.verificationLastOutcome;
  const verificationPassed = value.verificationPassed;
  const verificationSkipped = value.verificationSkipped;
  if (
    !Number.isFinite(detectedAt) ||
    !Number.isFinite(baselineProgressAt) ||
    !Number.isFinite(adjudicatedAt) ||
    (decision !== "continue" &&
      decision !== "nudge" &&
      decision !== "compact_recommended" &&
      decision !== "abort_recommended") ||
    (source !== "heuristic" && source !== "hook") ||
    rationale === null ||
    signalSummary === null ||
    (tapePressure !== "none" &&
      tapePressure !== "low" &&
      tapePressure !== "medium" &&
      tapePressure !== "high") ||
    !Number.isFinite(blockerCount) ||
    !Number.isFinite(blockedToolCount) ||
    !Number.isFinite(failureCount) ||
    !Number.isFinite(pendingWorkerResults) ||
    (verificationLastOutcome !== null &&
      verificationLastOutcome !== "pass" &&
      verificationLastOutcome !== "fail" &&
      verificationLastOutcome !== "skipped") ||
    typeof verificationPassed !== "boolean" ||
    typeof verificationSkipped !== "boolean"
  ) {
    return null;
  }
  return {
    schema: TASK_STALL_ADJUDICATION_SCHEMA,
    detectedAt,
    baselineProgressAt,
    adjudicatedAt,
    decision,
    source,
    rationale,
    signalSummary,
    tapePressure,
    blockerCount,
    blockedToolCount,
    failureCount,
    pendingWorkerResults,
    verificationLastOutcome,
    verificationPassed,
    verificationSkipped,
  };
}

export function isTaskWatchdogEventType(type: string): boolean {
  return (
    type === TASK_STUCK_DETECTED_EVENT_TYPE ||
    type === TASK_STUCK_CLEARED_EVENT_TYPE ||
    type === TASK_STALL_ADJUDICATED_EVENT_TYPE
  );
}
