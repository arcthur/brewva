import type { ChildProcess } from "node:child_process";
import type { BrewvaDeferred, BrewvaEffect, BrewvaScope } from "@brewva/brewva-effect";
import type { BrewvaWalId } from "@brewva/brewva-runtime/core";
import type { RecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import type {
  ParentToWorkerMessage,
  WorkerResultErrorCode,
  WorkerToParentMessage,
} from "../../hosted/internal/thread-loop/worker/api.js";
import type { ChildRegistryEntry } from "../../ingress/api.js";
import type { StructuredLogger } from "../logger.js";
import type {
  SendPromptOutput,
  SendPromptResult,
  SendPromptTrigger,
  SessionWorkerInfo,
} from "../session-backend.js";
import type { WorkerLifecycleState } from "../types.js";

export interface PendingRequest {
  deferred: BrewvaDeferred.Deferred<Record<string, unknown> | undefined, Error>;
}

export interface PendingTurn {
  deferred: BrewvaDeferred.Deferred<SendPromptOutput, Error>;
}

export interface QueuedTurn {
  requestedTurnId: string;
  prompt: string;
  source: "gateway" | "heartbeat" | "schedule";
  walReplayId?: string;
  trigger?: SendPromptTrigger;
  waitForCompletion: boolean;
  walId?: BrewvaWalId;
  resolve: (result: SendPromptResult) => void;
  reject: (error: Error) => void;
}

export interface WorkerHandle {
  sessionId: string;
  scope: BrewvaScope.Scope;
  child: ChildProcess;
  startedAt: number;
  lastActivityAt: number;
  cwd?: string;
  model?: string;
  agentId?: string;
  managedToolMode?: ManagedToolMode;
  requestedAgentSessionId?: string;
  agentEventLogPath?: string;
  pending: Map<string, PendingRequest>;
  pendingTurns: Map<string, PendingTurn>;
  turnQueue: QueuedTurn[];
  activeTurnId: string | null;
  activeRecoveryWalIds: Map<string, BrewvaWalId>;
  readyRequestId?: string;
  readyDeferred?: BrewvaDeferred.Deferred<WorkerReadyPayload, Error>;
  lastHeartbeatAt: number;
  lifecycleState: WorkerLifecycleState;
}

export interface WorkerReadyPayload {
  requestedSessionId: string;
  agentSessionId: string;
  agentEventLogPath: string;
}

export interface WorkerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type LoggerLike = Pick<StructuredLogger, "debug" | "info" | "warn" | "error" | "log">;

export interface WorkerRpcControllerDeps {
  logger: LoggerLike;
  recoveryWalStore?: RecoveryWalStore;
  onWorkerEvent?: (event: Extract<WorkerToParentMessage, { kind: "event" }>) => void;
  touchActivity(handle: WorkerHandle): void;
  onTurnQueueReady(handle: WorkerHandle): void;
  onWorkerExited(handle: WorkerHandle, exit: WorkerExitInfo): void;
}

export interface TurnQueueControllerDeps {
  requestEffect(
    handle: WorkerHandle,
    message: Exclude<ParentToWorkerMessage, { kind: "bridge.ping" | "init" }>,
    timeoutMs?: number,
  ): BrewvaEffect.Effect<Record<string, unknown> | undefined, Error>;
  registerPendingTurnEffect(
    handle: WorkerHandle,
    turnId: string,
    timeoutMs: number,
  ): BrewvaEffect.Effect<SendPromptOutput, Error>;
  rejectPendingTurn(handle: WorkerHandle, turnId: string, error: unknown): void;
  rekeyPendingTurn(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void;
  trackRecoveryWalId(handle: WorkerHandle, turnId: string, walId: BrewvaWalId): void;
  untrackRecoveryWalId(handle: WorkerHandle, turnId: string): BrewvaWalId | undefined;
  rekeyRecoveryWalId(handle: WorkerHandle, fromTurnId: string, toTurnId: string): void;
  markQueuedTurnInflight(walId: BrewvaWalId): void;
  markRecoveryWalFailed(handle: WorkerHandle, turnId: string, error?: string): void;
}

export interface WorkerRpcErrorInput {
  error: string;
  errorCode?: WorkerResultErrorCode;
}

export function isWorkerIdle(handle: WorkerHandle): boolean {
  return (
    handle.pending.size === 0 &&
    handle.pendingTurns.size === 0 &&
    handle.turnQueue.length === 0 &&
    !handle.activeTurnId &&
    !handle.readyRequestId
  );
}

export function toSessionWorkerInfo(handle: WorkerHandle): SessionWorkerInfo {
  return {
    sessionId: handle.sessionId,
    pid: handle.child.pid ?? 0,
    startedAt: handle.startedAt,
    lastHeartbeatAt: handle.lastHeartbeatAt,
    lastActivityAt: handle.lastActivityAt,
    pendingRequests: handle.pending.size + handle.pendingTurns.size + handle.turnQueue.length,
    agentSessionId: handle.requestedAgentSessionId,
    cwd: handle.cwd,
  };
}

export function toRegistryEntries(handles: Iterable<WorkerHandle>): ChildRegistryEntry[] {
  return [...handles]
    .map((handle) => ({
      sessionId: handle.sessionId,
      pid: handle.child.pid ?? 0,
      startedAt: handle.startedAt,
      agentSessionId: handle.requestedAgentSessionId,
      agentEventLogPath: handle.agentEventLogPath,
      cwd: handle.cwd,
    }))
    .filter((row) => row.pid > 0);
}
