import type { TurnEnvelope } from "../channels/turn.js";
import type { RuntimeResult } from "./shared.js";
import type { TaskPhase } from "./task.js";

export type ScheduleContinuityMode = "inherit" | "fresh";

export type ConvergencePredicate =
  | { kind: "truth_resolved"; factId: string }
  | { kind: "task_phase"; phase: TaskPhase }
  | { kind: "max_runs"; limit: number }
  | { kind: "all_of"; predicates: ConvergencePredicate[] }
  | { kind: "any_of"; predicates: ConvergencePredicate[] };

export type ScheduleIntentEventKind =
  | "intent_created"
  | "intent_updated"
  | "intent_cancelled"
  | "intent_fired"
  | "intent_converged";

export interface ScheduleIntentEventPayload {
  schema: "brewva.schedule.v1";
  kind: ScheduleIntentEventKind;
  intentId: string;
  cron?: string;
  timeZone?: string;
  runAt?: number;
  reason: string;
  goalRef?: string;
  parentSessionId: string;
  continuityMode: ScheduleContinuityMode;
  maxRuns: number;
  convergenceCondition?: ConvergencePredicate;
  runIndex?: number;
  firedAt?: number;
  nextRunAt?: number;
  childSessionId?: string;
  error?: string;
}

export type ScheduleIntentStatus = "active" | "cancelled" | "converged" | "error";

export interface ScheduleIntentProjectionRecord {
  intentId: string;
  parentSessionId: string;
  reason: string;
  goalRef?: string;
  continuityMode: ScheduleContinuityMode;
  cron?: string;
  timeZone?: string;
  runAt?: number;
  maxRuns: number;
  runCount: number;
  nextRunAt?: number;
  status: ScheduleIntentStatus;
  convergenceCondition?: ConvergencePredicate;
  consecutiveErrors: number;
  leaseUntilMs?: number;
  lastError?: string;
  lastEvaluationSessionId?: string;
  updatedAt: number;
  eventOffset: number;
}

export type TurnWALStatus = "pending" | "inflight" | "done" | "failed" | "expired";

export type TurnWALSource = "channel" | "schedule" | "gateway" | "heartbeat";

export interface TurnWALRecord {
  schema: "brewva.turn-wal.v1";
  walId: string;
  turnId: string;
  sessionId: string;
  channel: string;
  conversationId: string;
  status: TurnWALStatus;
  envelope: TurnEnvelope;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  source: TurnWALSource;
  error?: string;
  ttlMs?: number;
  dedupeKey?: string;
}

export interface TurnWALRecoverySummaryBySource {
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
}

export interface TurnWALRecoveryResult {
  recoveredAt: number;
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
  compacted: number;
  bySource: Record<TurnWALSource, TurnWALRecoverySummaryBySource>;
}

export interface ScheduleProjectionSnapshot {
  schema: "brewva.schedule.projection.v1";
  generatedAt: number;
  watermarkOffset: number;
  intents: ScheduleIntentProjectionRecord[];
}

export interface ScheduleIntentCreateInput {
  reason: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  intentId?: string;
  convergenceCondition?: ConvergencePredicate;
}

export type ScheduleIntentCreateResult = RuntimeResult<{ intent: ScheduleIntentProjectionRecord }>;

export interface ScheduleIntentCancelInput {
  intentId: string;
  reason?: string;
}

export type ScheduleIntentCancelResult = RuntimeResult;

export interface ScheduleIntentUpdateInput {
  intentId: string;
  reason?: string;
  goalRef?: string;
  continuityMode?: ScheduleContinuityMode;
  runAt?: number;
  cron?: string;
  timeZone?: string;
  maxRuns?: number;
  convergenceCondition?: ConvergencePredicate;
}

export type ScheduleIntentUpdateResult = RuntimeResult<{ intent: ScheduleIntentProjectionRecord }>;

export interface ScheduleIntentListQuery {
  parentSessionId?: string;
  status?: ScheduleIntentStatus;
}
