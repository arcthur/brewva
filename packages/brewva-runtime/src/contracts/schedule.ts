import type { TurnEnvelope } from "../channels/turn.js";
import type { BrewvaIntentId, BrewvaSessionId, BrewvaWalId } from "./identifiers.js";
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
  intentId: BrewvaIntentId;
  cron?: string;
  timeZone?: string;
  runAt?: number;
  reason: string;
  goalRef?: string;
  parentSessionId: BrewvaSessionId;
  continuityMode: ScheduleContinuityMode;
  maxRuns: number;
  convergenceCondition?: ConvergencePredicate;
  runIndex?: number;
  firedAt?: number;
  nextRunAt?: number;
  childSessionId?: BrewvaSessionId;
  error?: string;
}

export type ScheduleIntentStatus = "active" | "cancelled" | "converged" | "error";

export interface ScheduleIntentProjectionRecord {
  intentId: BrewvaIntentId;
  parentSessionId: BrewvaSessionId;
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

export type RecoveryWalStatus = "pending" | "inflight" | "done" | "failed" | "expired";

export type RecoveryWalSource = "channel" | "schedule" | "gateway" | "heartbeat" | "tool";

export interface RecoveryWalRecord {
  schema: "brewva.recovery-wal.v1";
  walId: BrewvaWalId;
  turnId: string;
  sessionId: BrewvaSessionId;
  channel: string;
  conversationId: string;
  status: RecoveryWalStatus;
  envelope: TurnEnvelope;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  source: RecoveryWalSource;
  error?: string;
  ttlMs?: number;
  dedupeKey?: string;
}

export interface RecoveryWalIngressWatermarkRecord {
  schema: "brewva.recovery-wal.ingress-watermark.v1";
  source: RecoveryWalSource;
  channel: string;
  ingressSequence: number;
  updatedAt: number;
}

export interface RecoveryWalRecoverySummaryBySource {
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
}

export interface RecoveryWalRecoveryResult {
  recoveredAt: number;
  scanned: number;
  retried: number;
  expired: number;
  failed: number;
  skipped: number;
  compacted: number;
  bySource: Record<RecoveryWalSource, RecoveryWalRecoverySummaryBySource>;
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
  intentId?: BrewvaIntentId;
  convergenceCondition?: ConvergencePredicate;
}

export type ScheduleIntentCreateResult = RuntimeResult<{ intent: ScheduleIntentProjectionRecord }>;

export interface ScheduleIntentCancelInput {
  intentId: BrewvaIntentId;
  reason?: string;
}

export type ScheduleIntentCancelResult = RuntimeResult;

export interface ScheduleIntentUpdateInput {
  intentId: BrewvaIntentId;
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
  parentSessionId?: BrewvaSessionId;
  status?: ScheduleIntentStatus;
}
