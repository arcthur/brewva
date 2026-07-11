import type { BrewvaSteerOutcome } from "@brewva/brewva-substrate/session";
import type { ContextStatusView } from "@brewva/brewva-vocabulary/context";
import type { OperationalClaim } from "@brewva/brewva-vocabulary/iteration";
import type {
  ScheduleApprovalMode,
  ScheduleContinuityMode,
  ScheduleIntentOrigin,
} from "@brewva/brewva-vocabulary/schedule";
import type { ManagedToolMode, SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { TaskSpec } from "@brewva/brewva-vocabulary/task";
import type { SessionWireFrame, ToolOutputView } from "@brewva/brewva-vocabulary/wire";

export interface OpenSessionInput {
  sessionId: string;
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  managedToolMode?: ManagedToolMode;
}

export interface OpenSessionResult {
  sessionId: string;
  created: boolean;
  workerPid: number;
  agentSessionId?: string;
}

export interface SchedulePromptAnchor {
  id: string;
  name?: string;
  summary?: string;
  nextSteps?: string;
}

/**
 * The identity of the schedule intent that drove this turn, persisted with the
 * turn envelope so a crash-recovery replay can re-resolve the approval envelope
 * from CURRENT config (never a stale, persisted raw grant). `origin` is the
 * daemon-only provenance stamp the approval resolver requires.
 */
export interface ScheduleIntentIdentity {
  intentId: string;
  parentSessionId: string;
  origin?: ScheduleIntentOrigin;
}

export interface SchedulePromptTrigger {
  kind: "schedule";
  continuityMode: ScheduleContinuityMode;
  intent?: ScheduleIntentIdentity;
  taskSpec?: TaskSpec | null;
  claims?: OperationalClaim[];
  parentAnchor?: SchedulePromptAnchor | null;
}

export type SendPromptTrigger = SchedulePromptTrigger;

export interface SessionWorkerInfo {
  sessionId: string;
  pid: number;
  startedAt: number;
  lastHeartbeatAt: number;
  lastActivityAt: number;
  pendingRequests: number;
  agentSessionId?: string;
  cwd?: string;
  // True once the worker has reported readiness and can accept turns. A
  // spawning or recovering worker is `false` even when it already carries a
  // requested agent session id.
  ready: boolean;
}

export type { ScheduleApprovalMode };

export interface SendPromptOptions {
  turnId?: string;
  waitForCompletion?: boolean;
  source?: "gateway" | "heartbeat" | "schedule";
  walReplayId?: string;
  trigger?: SendPromptTrigger;
  /**
   * Only meaningful for `source: "schedule"`. Set by the daemon from CONFIG
   * identity (the config-authored self-improve intent) — never from intent
   * records, so model-minted intents cannot smuggle an approval envelope.
   */
  approvalMode?: ScheduleApprovalMode;
}

export interface SendPromptOutput {
  assistantText: string;
  toolOutputs: readonly ToolOutputView[];
  attemptId: string;
}

export interface SendPromptResult {
  sessionId: string;
  agentSessionId?: string;
  turnId: string;
  accepted: true;
  output?: SendPromptOutput;
}

export type SessionAbortReason = "user_submit";

export interface SessionBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  openSession(input: OpenSessionInput): Promise<OpenSessionResult>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    options?: SendPromptOptions,
  ): Promise<SendPromptResult>;
  steerSession(sessionId: string, text: string): Promise<BrewvaSteerOutcome>;
  abortSession(sessionId: string, reason?: SessionAbortReason): Promise<boolean>;
  stopSession(sessionId: string, reason?: string, timeoutMs?: number): Promise<boolean>;
  listWorkers(): SessionWorkerInfo[];
  querySessionWire(sessionId: string): Promise<SessionWireFrame[]>;
  querySessionContextStatus(sessionId: string): Promise<ContextStatusView | undefined>;
  querySessionLifecycle(sessionId: string): Promise<SessionLifecycleSnapshot | undefined>;
}

export type SessionBackendCapacityCode = "worker_limit" | "open_queue_full";
export type SessionBackendStateCode =
  | "session_not_found"
  | "session_busy"
  | "duplicate_active_turn_id";

export class SessionBackendCapacityError extends Error {
  readonly name = "SessionBackendCapacityError";

  constructor(
    public readonly code: SessionBackendCapacityCode,
    message: string,
    public readonly details: {
      maxWorkers: number;
      currentWorkers: number;
      queueDepth: number;
      maxQueueDepth: number;
    },
  ) {
    super(message);
  }
}

export class SessionBackendStateError extends Error {
  readonly name = "SessionBackendStateError";

  constructor(
    public readonly code: SessionBackendStateCode,
    message: string,
  ) {
    super(message);
  }
}

export function isSessionBackendCapacityError(
  error: unknown,
): error is SessionBackendCapacityError {
  return error instanceof SessionBackendCapacityError;
}

export function isSessionBackendStateError(error: unknown): error is SessionBackendStateError {
  return error instanceof SessionBackendStateError;
}
