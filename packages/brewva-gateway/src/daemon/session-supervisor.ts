import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContextPressureView,
  type ManagedToolMode,
  type RecoveryWalRecord,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import {
  RecoveryWalRecovery,
  RecoveryWalStore,
  querySessionWireFramesFromEventLog,
} from "@brewva/brewva-runtime/internal";
import type { WorkerToParentMessage } from "../session/worker-protocol.js";
import {
  FileGatewayStateStore,
  type ChildRegistryEntry,
  type GatewayStateStore,
} from "../state-store.js";
import { sleep } from "../utils/async.js";
import { toErrorMessage } from "../utils/errors.js";
import { recordSessionShutdownReceiptToEventLogIfMissing } from "../utils/runtime.js";
import type { StructuredLogger } from "./logger.js";
import { isProcessAlive } from "./pid.js";
import {
  type OpenSessionInput,
  type OpenSessionResult,
  type SendPromptOptions,
  type SendPromptResult,
  type SessionBackend,
  SessionBackendStateError,
  type SessionWorkerInfo,
} from "./session-backend.js";
import {
  appendGatewaySessionBindingReceipt,
  listGatewaySessionBindings,
  resolveGatewaySessionBindingLogPath,
} from "./session-binding-tape.js";
import { SessionOpenAdmissionController } from "./session-supervisor/admission.js";
import {
  buildSessionTurnEnvelope,
  extractPromptFromEnvelope,
  extractTriggerFromEnvelope,
  normalizeOptionalString,
} from "./session-supervisor/turn-envelope.js";
import { SessionTurnQueueCoordinator } from "./session-supervisor/turn-queue.js";
import { SessionWorkerRpcController } from "./session-supervisor/worker-rpc.js";
import {
  type PendingRequest,
  type PendingTurn,
  type WorkerHandle,
  type WorkerExitInfo,
  type WorkerReadyPayload,
  isWorkerIdle,
  toRegistryEntries,
  toSessionWorkerInfo,
} from "./session-supervisor/worker-state.js";

const WORKER_READY_TIMEOUT_MS = 30_000;
const BRIDGE_PING_INTERVAL_MS = 4_000;
const BRIDGE_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WORKERS = 16;
const DEFAULT_MAX_PENDING_SESSION_OPENS = 64;
const DEFAULT_MAX_PENDING_TURNS_PER_SESSION = 32;
const DEFAULT_RECOVERY_WAL_COMPACT_INTERVAL_MS = 120_000;

type LoggerLike = Pick<StructuredLogger, "debug" | "info" | "warn" | "error" | "log">;

async function terminatePid(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

export interface SessionSupervisorOptions {
  stateDir: string;
  logger: LoggerLike;
  defaultCwd: string;
  defaultConfigPath?: string;
  defaultModel?: string;
  defaultManagedToolMode?: ManagedToolMode;
  workerEnv?: Record<string, string | undefined>;
  sessionIdleTtlMs?: number;
  sessionIdleSweepIntervalMs?: number;
  maxWorkers?: number;
  maxPendingSessionOpens?: number;
  stateStore?: GatewayStateStore;
  recoveryWalStore?: RecoveryWalStore;
  recoveryWalCompactIntervalMs?: number;
  onWorkerEvent?: (event: Extract<WorkerToParentMessage, { kind: "event" }>) => void;
}

export interface SessionSupervisorTestPendingRequest {
  requestId: string;
  resolve?: (payload: Record<string, unknown> | undefined) => void;
  reject?: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface SessionSupervisorTestWorkerInput {
  sessionId: string;
  pid: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastActivityAt?: number;
  cwd?: string;
  agentSessionId?: string;
  agentEventLogPath?: string;
  pendingRequests?: SessionSupervisorTestPendingRequest[];
  pendingCount?: number;
  readyRequestId?: string;
  activeTurnId?: string | null;
}

export interface SessionSupervisorTestWorkerSnapshot {
  sessionId: string;
  pendingRequests: number;
  pendingTurns: number;
  turnQueueLength: number;
  activeTurnId: string | null;
  readyRequestId?: string;
  lastActivityAt: number;
  lastHeartbeatAt: number;
}

export interface SessionSupervisorTestHooks {
  seedWorker(input: SessionSupervisorTestWorkerInput): void;
  resetWorkers(): void;
  persistRegistry(): void;
  dispatchWorkerMessage(sessionId: string, message: WorkerToParentMessage): void;
  replaceWorkerSend(sessionId: string, send: (message: unknown) => boolean): void;
  getWorkerSnapshot(sessionId: string): SessionSupervisorTestWorkerSnapshot | undefined;
  sweepIdleSessions(): Promise<void>;
}

export class SessionSupervisor implements SessionBackend {
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly stateDir: string;
  private readonly childrenRegistryPath: string;
  private readonly sessionBindingLogPath: string;
  private readonly sessionIdleTtlMs: number;
  private readonly sessionIdleSweepIntervalMs: number;
  private readonly maxWorkers: number;
  private readonly maxPendingSessionOpens: number;
  private readonly stateStore: GatewayStateStore;
  private readonly recoveryWalStore?: RecoveryWalStore;
  private readonly recoveryWalCompactIntervalMs: number;
  private readonly openAdmission: SessionOpenAdmissionController;
  private readonly workerRpc: SessionWorkerRpcController;
  private readonly turnQueue: SessionTurnQueueCoordinator;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryWalCompactTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweepInFlight = false;

  readonly testHooks: SessionSupervisorTestHooks = {
    seedWorker: (input) => {
      this.seedWorkerForTest(input);
    },
    resetWorkers: () => {
      this.workers.clear();
      this.persistRegistry();
    },
    persistRegistry: () => {
      this.persistRegistry();
    },
    dispatchWorkerMessage: (sessionId, message) => {
      this.dispatchWorkerMessageForTest(sessionId, message);
    },
    replaceWorkerSend: (sessionId, send) => {
      this.replaceWorkerSendForTest(sessionId, send);
    },
    getWorkerSnapshot: (sessionId) => {
      return this.getWorkerSnapshotForTest(sessionId);
    },
    sweepIdleSessions: async () => {
      await this.sweepIdleSessions();
    },
  };

  constructor(private readonly options: SessionSupervisorOptions) {
    this.stateDir = resolve(options.stateDir);
    this.childrenRegistryPath = resolve(this.stateDir, "children.json");
    this.sessionBindingLogPath = resolveGatewaySessionBindingLogPath(this.stateDir);
    this.stateStore = options.stateStore ?? new FileGatewayStateStore();
    this.recoveryWalStore = options.recoveryWalStore;
    this.recoveryWalCompactIntervalMs = Math.max(
      30_000,
      options.recoveryWalCompactIntervalMs ?? DEFAULT_RECOVERY_WAL_COMPACT_INTERVAL_MS,
    );
    this.sessionIdleTtlMs = Math.max(0, options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS);
    const defaultSweepIntervalMs = Math.min(
      DEFAULT_SESSION_IDLE_SWEEP_INTERVAL_MS,
      Math.max(1_000, Math.floor(this.sessionIdleTtlMs / 2)),
    );
    this.sessionIdleSweepIntervalMs = Math.max(
      1_000,
      options.sessionIdleSweepIntervalMs ?? defaultSweepIntervalMs,
    );
    this.maxWorkers = Math.max(1, options.maxWorkers ?? DEFAULT_MAX_WORKERS);
    this.maxPendingSessionOpens = Math.max(
      0,
      options.maxPendingSessionOpens ?? DEFAULT_MAX_PENDING_SESSION_OPENS,
    );

    this.openAdmission = new SessionOpenAdmissionController({
      logger: this.options.logger,
      maxWorkers: this.maxWorkers,
      maxPendingSessionOpens: this.maxPendingSessionOpens,
      getCurrentWorkers: () => this.workers.size,
    });
    this.workerRpc = new SessionWorkerRpcController({
      logger: this.options.logger,
      recoveryWalStore: this.recoveryWalStore,
      onWorkerEvent: this.options.onWorkerEvent,
      touchActivity: (handle) => {
        this.touchActivity(handle);
      },
      onTurnQueueReady: (handle) => {
        void this.turnQueue.pump(handle);
      },
      onWorkerExited: (handle, exit) => {
        this.onWorkerExited(handle, exit);
      },
    });
    this.turnQueue = new SessionTurnQueueCoordinator({
      request: (handle, message, timeoutMs) => this.workerRpc.request(handle, message, timeoutMs),
      registerPendingTurn: (handle, turnId, timeoutMs) =>
        this.workerRpc.registerPendingTurn(handle, turnId, timeoutMs),
      rejectPendingTurn: (handle, turnId, error) =>
        this.workerRpc.rejectPendingTurn(handle, turnId, error),
      rekeyPendingTurn: (handle, fromTurnId, toTurnId) =>
        this.workerRpc.rekeyPendingTurn(handle, fromTurnId, toTurnId),
      trackRecoveryWalId: (handle, turnId, walId) =>
        this.workerRpc.trackRecoveryWalId(handle, turnId, walId),
      untrackRecoveryWalId: (handle, turnId) => this.workerRpc.untrackRecoveryWalId(handle, turnId),
      rekeyRecoveryWalId: (handle, fromTurnId, toTurnId) =>
        this.workerRpc.rekeyRecoveryWalId(handle, fromTurnId, toTurnId),
      markQueuedTurnInflight: (walId) => {
        this.recoveryWalStore?.markInflight(walId);
      },
      markRecoveryWalFailed: (handle, turnId, error) =>
        this.workerRpc.markRecoveryWalFailed(handle, turnId, error),
    });

    mkdirSync(this.stateDir, { recursive: true });
  }

  async start(): Promise<void> {
    await this.sweepOrphanedChildren();
    await this.recoverRecoveryWalState();
    this.startBridgePing();
    this.startIdleSweep();
    this.startRecoveryWalCompaction();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    if (this.recoveryWalCompactTimer) {
      clearInterval(this.recoveryWalCompactTimer);
      this.recoveryWalCompactTimer = null;
    }

    await Promise.allSettled(
      [...this.workers.keys()].map(async (sessionId) => {
        await this.stopSession(sessionId, "shutdown", 5_000);
      }),
    );

    this.persistRegistry();
  }

  async sweepOrphanedChildren(): Promise<void> {
    const entries = this.readRegistry();
    if (entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      if (entry.pid === process.pid) {
        continue;
      }
      if (!isProcessAlive(entry.pid)) {
        this.ensureTerminalReceiptForRegistryEntry(entry, {
          source: "session_supervisor_registry_recovery",
          reason: "abnormal_process_exit",
          recoveredFromRegistry: true,
        });
        continue;
      }

      this.options.logger.warn("terminating orphan worker", {
        sessionId: entry.sessionId,
        pid: entry.pid,
      });
      await terminatePid(entry.pid);
      this.ensureTerminalReceiptForRegistryEntry(entry, {
        source: "session_supervisor_orphan_sweep",
        reason: "abnormal_process_exit",
        recoveredFromRegistry: true,
      });
    }

    this.persistRegistry();
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
    const existing = this.workers.get(input.sessionId);
    if (existing) {
      this.touchActivity(existing);
      return {
        sessionId: existing.sessionId,
        created: false,
        workerPid: existing.child.pid ?? 0,
        agentSessionId: existing.requestedAgentSessionId,
      };
    }

    await this.openAdmission.acquire(input.sessionId);

    try {
      const existingAfterWait = this.workers.get(input.sessionId);
      if (existingAfterWait) {
        this.touchActivity(existingAfterWait);
        return {
          sessionId: existingAfterWait.sessionId,
          created: false,
          workerPid: existingAfterWait.child.pid ?? 0,
          agentSessionId: existingAfterWait.requestedAgentSessionId,
        };
      }

      const child = this.spawnWorker();
      const resolvedCwd = input.cwd ?? this.options.defaultCwd;
      const resolvedConfigPath = input.configPath ?? this.options.defaultConfigPath;
      const handle: WorkerHandle = {
        sessionId: input.sessionId,
        child,
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        cwd: resolvedCwd,
        model: input.model,
        agentId: input.agentId,
        managedToolMode: input.managedToolMode,
        pending: new Map<string, PendingRequest>(),
        pendingTurns: new Map<string, PendingTurn>(),
        turnQueue: [],
        activeTurnId: null,
        activeRecoveryWalIds: new Map<string, string>(),
        lastHeartbeatAt: Date.now(),
      };
      this.workers.set(input.sessionId, handle);
      this.workerRpc.attachWorkerListeners(handle);

      const requestId = randomUUID();
      const ready = new Promise<WorkerReadyPayload>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => {
          handle.readyRequestId = undefined;
          handle.readyResolve = undefined;
          handle.readyReject = undefined;
          handle.readyTimer = undefined;
          rejectReady(new Error("worker init timeout"));
        }, WORKER_READY_TIMEOUT_MS);
        timer.unref?.();

        handle.readyRequestId = requestId;
        handle.readyResolve = resolveReady;
        handle.readyReject = rejectReady;
        handle.readyTimer = timer;
      });

      handle.child.send({
        kind: "init",
        requestId,
        payload: {
          sessionId: input.sessionId,
          cwd: resolvedCwd,
          configPath: resolvedConfigPath,
          model: input.model ?? this.options.defaultModel,
          agentId: input.agentId,
          managedToolMode: input.managedToolMode ?? this.options.defaultManagedToolMode,
          parentPid: process.pid,
        },
      });

      try {
        const readyPayload = await ready;
        handle.requestedAgentSessionId = readyPayload.agentSessionId;
        handle.agentEventLogPath = readyPayload.agentEventLogPath;
        appendGatewaySessionBindingReceipt(this.sessionBindingLogPath, {
          gatewaySessionId: input.sessionId,
          agentSessionId: readyPayload.agentSessionId,
          agentEventLogPath: readyPayload.agentEventLogPath,
          cwd: handle.cwd,
          timestamp: handle.startedAt,
        });
        this.touchActivity(handle);
        this.persistRegistry();
        this.options.logger.info("worker session opened", {
          sessionId: input.sessionId,
          workerPid: child.pid,
          agentSessionId: readyPayload.agentSessionId,
        });
        return {
          sessionId: input.sessionId,
          created: true,
          workerPid: child.pid ?? 0,
          agentSessionId: readyPayload.agentSessionId,
        };
      } catch (error) {
        this.workers.delete(input.sessionId);
        await terminatePid(child.pid ?? 0);
        this.persistRegistry();
        throw error;
      }
    } finally {
      this.openAdmission.release();
    }
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    options: SendPromptOptions = {},
  ): Promise<SendPromptResult> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.touchActivity(handle);

    const requestedTurnId = options.turnId?.trim() || randomUUID();
    if (this.turnQueue.hasOutstandingTurn(handle, requestedTurnId)) {
      throw new SessionBackendStateError(
        "duplicate_active_turn_id",
        `duplicate active turn id: ${requestedTurnId}`,
      );
    }
    if (handle.turnQueue.length >= DEFAULT_MAX_PENDING_TURNS_PER_SESSION) {
      throw new SessionBackendStateError(
        "session_busy",
        `session queue full for ${sessionId}: ${DEFAULT_MAX_PENDING_TURNS_PER_SESSION}`,
      );
    }

    const source = options.source ?? "gateway";
    const replayWalId = normalizeOptionalString(options.walReplayId);
    const waitForCompletion = options.waitForCompletion === true;
    let walId = replayWalId;
    if (!walId && this.recoveryWalStore?.isEnabled) {
      const walRecord = this.recoveryWalStore.appendPending(
        buildSessionTurnEnvelope({
          sessionId,
          turnId: requestedTurnId,
          prompt,
          source,
          trigger: options.trigger,
        }),
        source,
        {
          dedupeKey: `${source}:${sessionId}:${requestedTurnId}`,
        },
      );
      walId = walRecord.walId;
    }

    const queued = new Promise<SendPromptResult>((resolveQueued, rejectQueued) => {
      handle.turnQueue.push({
        requestedTurnId,
        prompt,
        source,
        walReplayId: replayWalId,
        trigger: options.trigger,
        waitForCompletion,
        walId,
        resolve: resolveQueued,
        reject: rejectQueued,
      });
    });
    void this.turnQueue.pump(handle);
    return queued;
  }

  async abortSession(sessionId: string, reason?: "user_submit"): Promise<boolean> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return false;
    }
    this.touchActivity(handle);

    await this.workerRpc.request(handle, {
      kind: "abort",
      requestId: randomUUID(),
      payload: reason ? { reason } : undefined,
    });
    return true;
  }

  async stopSession(sessionId: string, reason = "stop", timeoutMs = 5_000): Promise<boolean> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return false;
    }

    try {
      await this.workerRpc.request(
        handle,
        {
          kind: "shutdown",
          requestId: randomUUID(),
          payload: { reason },
        },
        timeoutMs,
      );
    } catch {
      // ignore and escalate kill
    }

    await terminatePid(handle.child.pid ?? 0);
    this.workers.delete(sessionId);
    this.persistRegistry();
    this.openAdmission.notifyIfAvailable();
    return true;
  }

  listWorkers(): SessionWorkerInfo[] {
    return [...this.workers.values()].map((handle) => toSessionWorkerInfo(handle));
  }

  async querySessionWire(sessionId: string): Promise<SessionWireFrame[]> {
    const handle = this.workers.get(sessionId);
    if (handle) {
      this.touchActivity(handle);
    }

    const segments = this.listSessionBindingsForReplay(sessionId);
    if (segments.length === 0) {
      return [];
    }

    const frames: SessionWireFrame[] = [];
    const durableFrameIds = new Set<string>();
    for (const segment of segments) {
      const segmentFrames = querySessionWireFramesFromEventLog({
        eventLogPath: segment.agentEventLogPath,
        sessionId: segment.agentSessionId,
      });
      for (const frame of segmentFrames) {
        if (frame.durability === "durable") {
          if (durableFrameIds.has(frame.frameId)) {
            continue;
          }
          durableFrameIds.add(frame.frameId);
        }
        frames.push(frame);
      }
    }
    return frames;
  }

  async querySessionContextPressure(sessionId: string): Promise<ContextPressureView | undefined> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return undefined;
    }
    this.touchActivity(handle);
    const payload = await this.workerRpc.request(handle, {
      kind: "sessionContextPressure.query",
      requestId: randomUUID(),
    });
    const candidate = payload && typeof payload === "object" ? payload.contextPressure : undefined;
    if (!candidate || typeof candidate !== "object") {
      return undefined;
    }
    const typed = candidate as Partial<ContextPressureView>;
    if (
      typeof typed.tokens !== "number" ||
      typeof typed.limit !== "number" ||
      (typed.level !== "normal" && typed.level !== "elevated" && typed.level !== "critical")
    ) {
      return undefined;
    }
    return {
      tokens: typed.tokens,
      limit: typed.limit,
      level: typed.level,
    };
  }

  private seedWorkerForTest(input: SessionSupervisorTestWorkerInput): void {
    const now = Date.now();
    const pending = new Map<string, PendingRequest>();
    for (const request of input.pendingRequests ?? []) {
      pending.set(request.requestId, {
        resolve: request.resolve ?? (() => undefined),
        reject: request.reject ?? (() => undefined),
        timer: request.timer ?? setTimeout(() => undefined, 5 * 60_000),
      });
    }

    for (const request of pending.values()) {
      request.timer.unref?.();
    }

    const pendingCount = Math.max(0, input.pendingCount ?? 0);
    for (let index = pending.size; index < pendingCount; index += 1) {
      const timer = setTimeout(() => undefined, 5 * 60_000);
      timer.unref?.();
      pending.set(`pending-${index}`, {
        resolve: () => undefined,
        reject: () => undefined,
        timer,
      });
    }

    const child = {
      pid: input.pid,
      send: () => true,
      on: () => undefined,
    } as unknown as ChildProcess;

    this.workers.set(input.sessionId, {
      sessionId: input.sessionId,
      child,
      startedAt: input.startedAt ?? now,
      lastActivityAt: input.lastActivityAt ?? now,
      cwd: input.cwd,
      requestedAgentSessionId: input.agentSessionId,
      agentEventLogPath: input.agentEventLogPath,
      pending,
      pendingTurns: new Map<string, PendingTurn>(),
      turnQueue: [],
      activeTurnId: input.activeTurnId ?? null,
      activeRecoveryWalIds: new Map<string, string>(),
      readyRequestId: input.readyRequestId,
      lastHeartbeatAt: input.lastHeartbeatAt ?? now,
    });
  }

  private dispatchWorkerMessageForTest(sessionId: string, message: WorkerToParentMessage): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.workerRpc.handleWorkerMessage(handle, message);
  }

  private replaceWorkerSendForTest(sessionId: string, send: (message: unknown) => boolean): void {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    handle.child.send = ((message: unknown) => send(message)) as ChildProcess["send"];
  }

  private getWorkerSnapshotForTest(
    sessionId: string,
  ): SessionSupervisorTestWorkerSnapshot | undefined {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return undefined;
    }
    return {
      sessionId: handle.sessionId,
      pendingRequests: handle.pending.size,
      pendingTurns: handle.pendingTurns.size,
      turnQueueLength: handle.turnQueue.length,
      activeTurnId: handle.activeTurnId,
      readyRequestId: handle.readyRequestId,
      lastActivityAt: handle.lastActivityAt,
      lastHeartbeatAt: handle.lastHeartbeatAt,
    };
  }

  private spawnWorker(): ChildProcess {
    const workerModulePath = fileURLToPath(new URL("../session/worker-main.js", import.meta.url));
    return fork(workerModulePath, {
      cwd: this.options.defaultCwd,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        ...process.env,
        ...this.options.workerEnv,
        BREWVA_GATEWAY_WORKER: "1",
      },
      execArgv: [],
    });
  }

  private onWorkerExited(handle: WorkerHandle, exit: WorkerExitInfo): void {
    this.workers.delete(handle.sessionId);
    this.ensureTerminalReceiptForHandle(handle, exit);
    this.persistRegistry();
    this.openAdmission.notifyIfAvailable();
  }

  private ensureTerminalReceiptForRegistryEntry(
    entry: ChildRegistryEntry,
    input: {
      source: string;
      reason: string;
      exitCode?: number | null;
      signal?: string | null;
      recoveredFromRegistry?: boolean;
    },
  ): void {
    const agentSessionId = normalizeOptionalString(entry.agentSessionId);
    if (!agentSessionId) {
      return;
    }
    const eventLogPath = normalizeOptionalString(entry.agentEventLogPath);
    if (!eventLogPath) {
      this.options.logger.warn(
        "cannot synthesize session terminal receipt without agent event log path",
        {
          sessionId: entry.sessionId,
          agentSessionId,
          source: input.source,
        },
      );
      return;
    }
    try {
      recordSessionShutdownReceiptToEventLogIfMissing({
        eventLogPath,
        sessionId: agentSessionId,
        reason: input.reason,
        source: input.source,
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null,
        workerSessionId: entry.sessionId,
        recoveredFromRegistry: input.recoveredFromRegistry,
      });
    } catch (error) {
      this.options.logger.warn("failed to synthesize session terminal receipt", {
        sessionId: entry.sessionId,
        agentSessionId,
        source: input.source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureTerminalReceiptForHandle(handle: WorkerHandle, exit: WorkerExitInfo): void {
    this.ensureTerminalReceiptForRegistryEntry(
      {
        sessionId: handle.sessionId,
        pid: handle.child.pid ?? 0,
        startedAt: handle.startedAt,
        agentSessionId: handle.requestedAgentSessionId,
        agentEventLogPath: handle.agentEventLogPath,
        cwd: handle.cwd,
      },
      {
        source: "session_supervisor_worker_exit",
        reason:
          exit.signal || (typeof exit.code === "number" && exit.code !== 0)
            ? "abnormal_process_exit"
            : "process_exit_without_terminal_receipt",
        exitCode: exit.code,
        signal: exit.signal,
      },
    );
  }

  private touchActivity(handle: WorkerHandle): void {
    handle.lastActivityAt = Date.now();
  }

  private startBridgePing(): void {
    if (this.pingTimer) {
      return;
    }

    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const handle of this.workers.values()) {
        if (now - handle.lastHeartbeatAt > BRIDGE_HEARTBEAT_TIMEOUT_MS) {
          this.options.logger.warn("worker heartbeat timeout", {
            sessionId: handle.sessionId,
            pid: handle.child.pid,
          });
          void this.stopSession(handle.sessionId, "heartbeat_timeout");
          continue;
        }

        handle.child.send({
          kind: "bridge.ping",
          ts: now,
        });
      }
    }, BRIDGE_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private startIdleSweep(): void {
    if (this.sessionIdleTtlMs <= 0 || this.idleSweepTimer) {
      return;
    }

    this.idleSweepTimer = setInterval(() => {
      if (this.idleSweepInFlight) {
        return;
      }
      this.idleSweepInFlight = true;
      void this.sweepIdleSessions()
        .catch((error: unknown) => {
          this.options.logger.warn("idle session sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.idleSweepInFlight = false;
        });
    }, this.sessionIdleSweepIntervalMs);
    this.idleSweepTimer.unref?.();
    this.options.logger.info("session idle sweep started", {
      ttlMs: this.sessionIdleTtlMs,
      intervalMs: this.sessionIdleSweepIntervalMs,
    });
  }

  private async sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const handle of this.workers.values()) {
      if (!isWorkerIdle(handle)) {
        continue;
      }
      const idleMs = now - handle.lastActivityAt;
      if (idleMs < this.sessionIdleTtlMs) {
        continue;
      }

      this.options.logger.info("stopping idle worker session", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        idleMs,
        ttlMs: this.sessionIdleTtlMs,
      });
      try {
        await this.stopSession(handle.sessionId, "idle_timeout");
      } catch (error) {
        this.options.logger.warn("failed to stop idle worker session", {
          sessionId: handle.sessionId,
          pid: handle.child.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async recoverRecoveryWalState(): Promise<void> {
    if (!this.recoveryWalStore?.isEnabled) {
      return;
    }
    const recovery = new RecoveryWalRecovery({
      workspaceRoot: this.recoveryWalStore.workspaceRoot,
      config: this.recoveryWalStore.config,
      scopeFilter: (scope) => scope === this.recoveryWalStore?.scope,
      handlers: {
        gateway: async ({ record }) => {
          await this.replayRecoveredTurn(record);
        },
        heartbeat: async ({ record }) => {
          await this.replayRecoveredTurn(record);
        },
        schedule: async ({ record }) => {
          await this.replayRecoveredTurn(record);
        },
      },
    });

    const summary = await recovery.recover();
    if (summary.scanned > 0 || summary.retried > 0 || summary.failed > 0 || summary.expired > 0) {
      this.options.logger.info("Recovery WAL recovery completed", {
        scope: this.recoveryWalStore.scope,
        scanned: summary.scanned,
        retried: summary.retried,
        failed: summary.failed,
        expired: summary.expired,
        skipped: summary.skipped,
      });
    }
  }

  private async replayRecoveredTurn(record: RecoveryWalRecord): Promise<void> {
    const source =
      record.source === "heartbeat"
        ? "heartbeat"
        : record.source === "schedule"
          ? "schedule"
          : "gateway";
    const sessionId = normalizeOptionalString(record.envelope.sessionId) ?? record.sessionId;
    const prompt = extractPromptFromEnvelope(record.envelope);
    const trigger = extractTriggerFromEnvelope(record.envelope);
    if (!sessionId || !prompt) {
      this.recoveryWalStore?.markFailed(record.walId, "recovery_missing_prompt_or_session");
      return;
    }

    await this.openSession({ sessionId });
    await this.sendPrompt(sessionId, prompt, {
      turnId: record.turnId,
      source,
      walReplayId: record.walId,
      waitForCompletion: false,
      trigger,
    });
  }

  private startRecoveryWalCompaction(): void {
    if (!this.recoveryWalStore?.isEnabled || this.recoveryWalCompactTimer) {
      return;
    }
    this.recoveryWalCompactTimer = setInterval(() => {
      try {
        const result = this.recoveryWalStore?.compact();
        if (result && result.dropped > 0) {
          this.options.logger.debug("Recovery WAL compacted", {
            scope: this.recoveryWalStore?.scope,
            scanned: result.scanned,
            retained: result.retained,
            dropped: result.dropped,
          });
        }
      } catch (error) {
        this.options.logger.warn("Recovery WAL compaction failed", {
          error: toErrorMessage(error),
        });
      }
    }, this.recoveryWalCompactIntervalMs);
    this.recoveryWalCompactTimer.unref?.();
  }

  private readRegistry(): ChildRegistryEntry[] {
    return this.stateStore.readChildrenRegistry(this.childrenRegistryPath);
  }

  private listSessionBindingsForReplay(sessionId: string): Array<{
    sessionId: string;
    agentSessionId: string;
    agentEventLogPath: string;
    openedAt: number;
    cwd?: string;
  }> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const seen = new Set<string>();
    return listGatewaySessionBindings(this.sessionBindingLogPath, normalizedSessionId).flatMap(
      (entry) => {
        const key = `${entry.gatewaySessionId}::${entry.agentSessionId}::${entry.agentEventLogPath}`;
        if (seen.has(key)) {
          return [];
        }
        seen.add(key);
        return [
          {
            sessionId: entry.gatewaySessionId,
            agentSessionId: entry.agentSessionId,
            agentEventLogPath: entry.agentEventLogPath,
            openedAt: entry.openedAt,
            cwd: entry.cwd,
          },
        ];
      },
    );
  }

  private persistRegistry(): void {
    const rows = toRegistryEntries(this.workers.values());
    if (rows.length === 0) {
      this.stateStore.removeChildrenRegistry(this.childrenRegistryPath);
      return;
    }

    try {
      this.stateStore.writeChildrenRegistry(this.childrenRegistryPath, rows);
    } catch (error) {
      this.options.logger.warn("failed to persist worker registry", {
        path: this.childrenRegistryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
