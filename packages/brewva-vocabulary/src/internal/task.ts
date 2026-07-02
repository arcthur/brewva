import { payloadOf, type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export const TASK_STALL_ADJUDICATED_EVENT_TYPE = "task.stall.adjudicated" as const;

export const TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE = "task.stall.error" as const;

export const TASK_STUCK_DETECTED_EVENT_TYPE = "task.stuck.detected" as const;

// Runtime-ops task lifecycle events: emitted by the hosted task builder and folded by the
// runtime-ops task projections. Shared so the emit site and the projection never drift on
// the event-type string (a typo or a missed projection branch would silently lose the fold).
export const TASK_SPEC_SET_EVENT_TYPE = "task.spec.set" as const;
export const TASK_ITEM_ADDED_EVENT_TYPE = "task.item.added" as const;
export const TASK_ITEM_UPDATED_EVENT_TYPE = "task.item.updated" as const;
export const TASK_BLOCKER_RECORDED_EVENT_TYPE = "task.blocker.recorded" as const;
export const TASK_BLOCKER_RESOLVED_EVENT_TYPE = "task.blocker.resolved" as const;
export const TASK_ACCEPTANCE_RECORDED_EVENT_TYPE = "task.acceptance.recorded" as const;

export const TASK_AGENT_ITEM_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;

export const TASK_AGENT_ITEM_STATUS_RUNTIME_MAP = Object.freeze({
  pending: "pending",
  in_progress: "in_progress",
  completed: "done",
  blocked: "blocked",
});

export type TaskItemStatus = string;

export type TaskPhase = string;

export interface TaskSpec extends ProtocolRecord {
  readonly goal?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly constraints?: readonly string[];
}

export interface TaskState {
  readonly blockers: Array<{
    readonly id?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
  }>;
  readonly spec?: TaskSpec | null;
  readonly status?: TaskStatus;
  readonly acceptance?: TaskAcceptanceState;
  readonly items: unknown[];
  readonly updatedAt?: number | null;
  readonly [key: string]: unknown;
}

export type TaskAcceptanceRecordResult =
  | { readonly ok: true; readonly status: TaskAcceptanceState["status"] }
  | { readonly ok: false; readonly reason: string };

export interface TaskAcceptanceState extends ProtocolRecord {
  readonly status?: "pending" | "accepted" | "rejected";
}

export type TaskBlockerRecordResult =
  | { readonly ok: true; readonly blockerId: string }
  | { readonly ok: false; readonly reason: string };

export type TaskBlockerResolveResult =
  | { readonly ok: true; readonly blockerId?: string }
  | { readonly ok: false; readonly reason: string };

export interface TaskItem extends ProtocolRecord {
  readonly id: string;
  readonly text: string;
  readonly status?: TaskItemStatus;
}

export type TaskItemAddResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };

export type TaskItemUpdateResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };

export interface TaskLedgerEventPayload extends ProtocolRecord {}

export interface TaskStatus extends ProtocolRecord {
  readonly phase?: string;
  readonly health?: string;
}

export interface TaskTargetDescriptor extends ProtocolRecord {}

export interface TaskStallAdjudicatedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly adjudicatedAt?: number;
  readonly decision: "accepted" | "rejected" | "pending";
  readonly source: string;
  readonly rationale?: string | null;
  readonly signalSummary: string[];
  readonly verificationLastOutcome?: "pass" | "fail" | "skipped" | null;
}

export type TaskStallAdjudicationDecision = string;

export interface TaskStuckDetectedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly thresholdMs: number;
  readonly idleMs: number;
  readonly openItemCount: number;
  readonly reason?: string | null;
}

export function createEmptyTaskState(): TaskState {
  return { items: [], blockers: [], status: { phase: "pending" } };
}

export function normalizeTaskSpec(value: unknown): TaskSpec {
  return typeof value === "object" && value !== null
    ? (value as ProtocolRecord)
    : {
        description: typeof value === "string" ? value : value == null ? "" : JSON.stringify(value),
      };
}

export function reduceTaskState(state: TaskState, payload: TaskLedgerEventPayload): TaskState {
  return { ...state, lastEvent: payload };
}

export function foldTaskLedgerEvents(events: readonly BrewvaEventRecord[]): TaskState {
  return events.reduce(
    (state, entry) => reduceTaskState(state, payloadOf(entry)),
    createEmptyTaskState(),
  );
}

export function formatTaskStateBlock(state: TaskState): string {
  return JSON.stringify(state, null, 2);
}

export function formatTaskVerificationLevelForSurface(level: unknown): string {
  return typeof level === "string" && level.trim().length > 0 ? level : "none";
}

export const TASK_STALL_ADJUDICATION_SCHEMA = "brewva.task.stall-adjudication.v1" as const;

export function buildTaskStallAdjudicatedPayload(
  input: ProtocolRecord,
): TaskStallAdjudicatedPayload {
  return {
    schema: TASK_STALL_ADJUDICATION_SCHEMA,
    ...input,
  } as unknown as TaskStallAdjudicatedPayload;
}

export function coerceTaskStallAdjudicatedPayload(
  value: unknown,
): TaskStallAdjudicatedPayload | null {
  return typeof value === "object" && value !== null
    ? (value as TaskStallAdjudicatedPayload)
    : null;
}

export function toTaskWatchdogEventPayload(input: ProtocolRecord): ProtocolRecord {
  return input;
}

export const readTaskStallAdjudicatedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStallAdjudicatedPayload | null =>
  event.payload ? (event.payload as TaskStallAdjudicatedPayload) : null;

export const readTaskStuckDetectedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStuckDetectedPayload | null =>
  event.payload ? (event.payload as TaskStuckDetectedPayload) : null;
