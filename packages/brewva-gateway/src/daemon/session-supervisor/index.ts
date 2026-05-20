import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBoundaryOperation,
  runSyncAtBoundary,
  startBoundaryInterval,
  type BoundaryIntervalHandle,
} from "@brewva/brewva-effect";
import {
  BrewvaDuration,
  BrewvaEffect,
  BrewvaExit,
  BrewvaScope,
} from "@brewva/brewva-effect/primitives";
import { BrewvaDeferred } from "@brewva/brewva-effect/primitives";
import {
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
  type CanonicalEvent,
} from "@brewva/brewva-runtime";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
  asBrewvaWalId,
} from "@brewva/brewva-runtime/core";
import type { BrewvaWalId } from "@brewva/brewva-runtime/core";
import type { RecoveryWalRecord } from "@brewva/brewva-runtime/protocol";
import type {
  BrewvaStructuredEvent,
  ContextStatusView,
  ManagedToolMode,
  SessionLifecycleSnapshot,
  SessionWireFrame,
  SessionWireTurnTrigger,
  ToolOutputView,
} from "@brewva/brewva-runtime/protocol";
import { compileSessionWireFrames } from "@brewva/brewva-runtime/protocol";
import type { BrewvaSteerOutcome } from "@brewva/brewva-substrate/session";
import type { WorkerToParentMessage } from "../../hosted/internal/turn-adapter/worker/api.js";
import {
  FileGatewayStateStore,
  type ChildRegistryEntry,
  type GatewayStateStore,
} from "../../ingress/api.js";
import { sleep } from "../../utils/async.js";
import { toErrorMessage } from "../../utils/errors.js";
import type { StructuredLogger } from "../logger.js";
import { isProcessAlive } from "../pid.js";
import { createRecoveryWalRecovery, type RecoveryWalStore } from "../recovery.js";
import {
  type OpenSessionInput,
  type OpenSessionResult,
  type SendPromptOptions,
  type SendPromptResult,
  type SessionBackend,
  SessionBackendStateError,
  type SessionWorkerInfo,
} from "../session-backend.js";
import {
  createWorkerBusyState,
  createWorkerReadyState,
  createWorkerSpawnedState,
} from "../types.js";
import { SessionOpenAdmissionController } from "./admission.js";
import {
  appendGatewaySessionBindingReceipt,
  listGatewaySessionBindings,
  resolveGatewaySessionBindingStorePath,
} from "./session-binding-store.js";
import {
  buildSessionTurnEnvelope,
  extractPromptFromEnvelope,
  extractTriggerFromEnvelope,
  normalizeOptionalString,
} from "./turn-envelope.js";
import { SessionTurnQueueCoordinator } from "./turn-queue.js";
import { SessionWorkerRpcController } from "./worker-rpc.js";
import {
  type PendingRequest,
  type PendingTurn,
  type WorkerHandle,
  type WorkerExitInfo,
  type WorkerReadyPayload,
  isWorkerIdle,
  toRegistryEntries,
  toSessionWorkerInfo,
} from "./worker-state.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isContextStatusView(value: unknown): value is ContextStatusView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<ContextStatusView>;
  return (
    isFiniteNumber(candidate.tokensUsed) &&
    isFiniteNumber(candidate.tokensTotal) &&
    isFiniteNumber(candidate.tokensRemaining) &&
    isFiniteNumber(candidate.tokensUntilForcedCompact) &&
    isFiniteNumber(candidate.predictedTurnGrowthTokens) &&
    isFiniteNumber(candidate.tokensUntilPredictedOverflow) &&
    typeof candidate.predictedOverflow === "boolean" &&
    isFiniteNumber(candidate.usageRatio) &&
    isFiniteNumber(candidate.hardLimitRatio) &&
    isFiniteNumber(candidate.compactionThresholdRatio) &&
    typeof candidate.compactionAdvised === "boolean" &&
    typeof candidate.forcedCompaction === "boolean"
  );
}

function canonicalTapePath(input: { cwd: string; sessionId: string }): string {
  return resolve(
    input.cwd,
    DEFAULT_BREWVA_CONFIG.tape.dir,
    `${encodeURIComponent(input.sessionId)}.jsonl`,
  );
}

function isCanonicalEvent(value: unknown): value is CanonicalEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.type === "string" &&
    typeof value.timestamp === "number"
  );
}

function readCanonicalTapeEvents(input: { cwd: string; sessionId: string }): CanonicalEvent[] {
  const path = canonicalTapePath(input);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return isCanonicalEvent(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function promptTextFromCanonicalTurnStarted(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  if (typeof payload.prompt === "string") {
    return payload.prompt;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      if (part.type === "file") {
        if (typeof part.displayText === "string") return part.displayText;
        if (typeof part.name === "string") return part.name;
        if (typeof part.uri === "string") return part.uri;
      }
      return "";
    })
    .join("");
}

function canonicalTriggerFromMode(payload: unknown): SessionWireTurnTrigger {
  const mode = isRecord(payload) && typeof payload.mode === "string" ? payload.mode : "";
  switch (mode) {
    case "scheduled":
      return "schedule";
    case "heartbeat":
      return "heartbeat";
    case "channel":
      return "channel";
    case "wal_recovery":
      return "recovery";
    case "subagent":
      return "subagent";
    default:
      return "user";
  }
}

function canonicalAssistantText(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.text === "string" ? payload.text : null;
}

function canonicalContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "[unserializable content]";
  }
}

function canonicalToolOutput(event: CanonicalEvent): ToolOutputView | null {
  if (event.type !== "tool.committed" || !isRecord(event.payload)) {
    return null;
  }
  const call = isRecord(event.payload.call) ? event.payload.call : null;
  const result = isRecord(event.payload.result) ? event.payload.result : null;
  if (!call || typeof call.toolCallId !== "string" || typeof call.toolName !== "string") {
    return null;
  }
  return {
    toolCallId: asBrewvaToolCallId(call.toolCallId),
    toolName: asBrewvaToolName(call.toolName),
    verdict: result?.ok === false ? "fail" : "pass",
    isError: result?.ok === false,
    text: canonicalContentText(result?.content),
  };
}

function readCanonicalEventRecord(event: CanonicalEvent): BrewvaStructuredEvent | null {
  if (event.type !== "custom" || !isRecord(event.payload)) {
    return null;
  }
  if (typeof event.payload.kind !== "string" || event.payload.version !== 1) {
    return null;
  }
  if (event.payload.namespace === "gateway.ops") {
    const payload = isRecord(event.payload.payload)
      ? (event.payload.payload as Record<string, never>)
      : undefined;
    return {
      schema: "brewva.event.v1",
      id: event.id,
      sessionId: asBrewvaSessionId(event.sessionId),
      type: event.payload.kind.trim(),
      category: "other",
      timestamp: event.timestamp,
      isoTime: new Date(event.timestamp).toISOString(),
      ...(typeof event.turnId === "string" && event.turnId.trim().length > 0
        ? { turn: Number(event.turnId) }
        : {}),
      ...(payload ? { payload } : {}),
    };
  }
  return null;
}

function querySessionWireFramesFromCanonicalTape(input: {
  cwd: string;
  sessionId: string;
}): SessionWireFrame[] {
  const events = readCanonicalTapeEvents(input);
  const frames: SessionWireFrame[] = [];
  const operationalEvents = events.flatMap((event) => {
    const record = readCanonicalEventRecord(event);
    return record ? [record] : [];
  });
  const readModelFrames = compileSessionWireFrames(operationalEvents, "replay");
  frames.push(...readModelFrames);
  for (const event of operationalEvents) {
    if (event.type !== "session_shutdown") {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    frames.push({
      schema: "brewva.session-wire.v2",
      sessionId: asBrewvaSessionId(event.sessionId),
      frameId: `canonical:${event.id}:session.closed`,
      ts: event.timestamp,
      source: "replay",
      durability: "durable",
      sourceEventId: event.id,
      sourceEventType: event.type,
      type: "session.closed",
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
    });
  }
  const assistantTextByTurnId = new Map<string, string>();
  const toolOutputsByTurnId = new Map<string, ToolOutputView[]>();
  for (const event of events) {
    const turnId = event.turnId?.trim();
    if (!turnId) {
      continue;
    }
    if (event.type === "turn.started") {
      frames.push({
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId(event.sessionId),
        frameId: `canonical:${event.id}:turn.input`,
        ts: event.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.input",
        turnId,
        trigger: canonicalTriggerFromMode(event.payload),
        promptText: promptTextFromCanonicalTurnStarted(event.payload),
      });
      continue;
    }
    if (event.type === "msg.committed") {
      const text = canonicalAssistantText(event.payload);
      if (text !== null) {
        assistantTextByTurnId.set(turnId, `${assistantTextByTurnId.get(turnId) ?? ""}${text}`);
      }
      continue;
    }
    const toolOutput = canonicalToolOutput(event);
    if (toolOutput) {
      const outputs = toolOutputsByTurnId.get(turnId) ?? [];
      outputs.push(toolOutput);
      toolOutputsByTurnId.set(turnId, outputs);
      continue;
    }
    if (event.type === "turn.ended") {
      frames.push({
        schema: "brewva.session-wire.v2",
        sessionId: asBrewvaSessionId(event.sessionId),
        frameId: `canonical:${event.id}:turn.committed`,
        ts: event.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.committed",
        turnId,
        attemptId: "runtime-turn",
        status: "completed",
        assistantText: assistantTextByTurnId.get(turnId) ?? "",
        toolOutputs: toolOutputsByTurnId.get(turnId) ?? [],
      });
    }
  }
  return frames;
}

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
  } catch {}
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
  recoveryWalContext?: {
    workspaceRoot: string;
    config: BrewvaConfig["infrastructure"]["recoveryWal"];
  };
  recoveryWalCompactIntervalMs?: number;
  onWorkerEvent?: (event: Extract<WorkerToParentMessage, { kind: "event" }>) => void;
}

export interface SessionSupervisorTestPendingRequest {
  requestId: string;
  resolve?: (payload: Record<string, unknown> | undefined) => void;
  reject?: (error: Error) => void;
}

export interface SessionSupervisorTestWorkerInput {
  sessionId: string;
  pid: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastActivityAt?: number;
  cwd?: string;
  agentSessionId?: string;
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
  private readonly sessionBindingStorePath: string;
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
  private readonly supervisorScope: BrewvaScope.Closeable;
  private pingLoop: BoundaryIntervalHandle | null = null;
  private idleSweepLoop: BoundaryIntervalHandle | null = null;
  private recoveryWalCompactLoop: BoundaryIntervalHandle | null = null;

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
    this.supervisorScope = runSyncAtBoundary(BrewvaScope.make());
    this.stateDir = resolve(options.stateDir);
    this.childrenRegistryPath = resolve(this.stateDir, "children.json");
    this.sessionBindingStorePath = resolveGatewaySessionBindingStorePath(this.stateDir);
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
    const loops = [this.pingLoop, this.idleSweepLoop, this.recoveryWalCompactLoop].filter(
      (loop): loop is BoundaryIntervalHandle => loop !== null,
    );
    this.pingLoop = null;
    this.idleSweepLoop = null;
    this.recoveryWalCompactLoop = null;
    await Promise.allSettled(loops.map((loop) => loop.close()));

    await Promise.allSettled(
      [...this.workers.keys()].map(async (sessionId) => {
        await this.stopSession(sessionId, "shutdown", 5_000);
      }),
    );

    this.persistRegistry();
    await runBoundaryOperation(
      "gateway.sessionSupervisor.closeScope",
      BrewvaScope.close(this.supervisorScope, BrewvaExit.succeed(undefined)),
    );
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
        scope: this.createWorkerScope(child),
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
        activeRecoveryWalIds: new Map<string, BrewvaWalId>(),
        lastHeartbeatAt: Date.now(),
        lifecycleState: createWorkerSpawnedState(
          String(child.pid ?? input.sessionId),
          input.sessionId,
        ),
      };
      this.workers.set(input.sessionId, handle);
      this.workerRpc.attachWorkerListeners(handle);

      const requestId = randomUUID();
      const readyDeferred = runSyncAtBoundary(BrewvaDeferred.make<WorkerReadyPayload, Error>());
      handle.readyRequestId = requestId;
      handle.readyDeferred = readyDeferred;

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
        const readyPayload = await runBoundaryOperation(
          "gateway.sessionSupervisor.workerReady",
          BrewvaEffect.race(
            BrewvaDeferred.await(readyDeferred),
            BrewvaEffect.sleep(BrewvaDuration.millis(WORKER_READY_TIMEOUT_MS)).pipe(
              BrewvaEffect.andThen(BrewvaEffect.fail(new Error("worker init timeout"))),
            ),
          ).pipe(
            BrewvaEffect.ensuring(
              BrewvaEffect.sync(() => {
                if (handle.readyDeferred === readyDeferred) {
                  handle.readyRequestId = undefined;
                  handle.readyDeferred = undefined;
                }
              }),
            ),
          ),
        );
        handle.requestedAgentSessionId = readyPayload.agentSessionId;
        handle.lifecycleState = createWorkerReadyState(
          String(child.pid ?? input.sessionId),
          input.sessionId,
        );
        appendGatewaySessionBindingReceipt(this.sessionBindingStorePath, {
          gatewaySessionId: input.sessionId,
          agentSessionId: readyPayload.agentSessionId,
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
    let walId = replayWalId ? asBrewvaWalId(replayWalId) : undefined;
    if (!walId && this.recoveryWalStore?.isWalEnabled()) {
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

  async steerSession(sessionId: string, text: string): Promise<BrewvaSteerOutcome> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      throw new SessionBackendStateError("session_not_found", `session not found: ${sessionId}`);
    }
    this.touchActivity(handle);
    const payload = await this.workerRpc.request(handle, {
      kind: "steer",
      requestId: randomUUID(),
      payload: { text },
    });
    const status = payload?.status;
    if (status !== "queued" && status !== "no_active_run" && status !== "rejected_empty") {
      throw new Error("worker returned an invalid steer result");
    }
    switch (status) {
      case "queued":
        if (typeof payload?.chars !== "number") {
          throw new Error("worker returned an invalid queued steer result");
        }
        return { status: "queued", chars: payload.chars };
      case "no_active_run":
        return { status: "no_active_run" };
      case "rejected_empty":
        return { status: "rejected_empty" };
    }
    throw new Error("worker returned an unreachable steer result");
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
    } catch {}

    await terminatePid(handle.child.pid ?? 0);
    await this.closeWorkerScope(handle);
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
      const canonicalFrames = querySessionWireFramesFromCanonicalTape({
        cwd: segment.cwd ?? this.options.defaultCwd,
        sessionId: segment.agentSessionId,
      });
      for (const frame of canonicalFrames) {
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

  async querySessionContextStatus(sessionId: string): Promise<ContextStatusView | undefined> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return undefined;
    }
    this.touchActivity(handle);
    const payload = await this.workerRpc.request(handle, {
      kind: "sessionContextStatus.query",
      requestId: randomUUID(),
    });
    const candidate = payload && typeof payload === "object" ? payload.contextStatus : undefined;
    if (!isContextStatusView(candidate)) {
      return undefined;
    }
    return candidate;
  }

  async querySessionLifecycle(sessionId: string): Promise<SessionLifecycleSnapshot | undefined> {
    const handle = this.workers.get(sessionId);
    if (!handle) {
      return undefined;
    }
    this.touchActivity(handle);
    const payload = await this.workerRpc.request(handle, {
      kind: "sessionLifecycle.query",
      requestId: randomUUID(),
    });
    const candidate = payload && typeof payload === "object" ? payload.lifecycle : undefined;
    return candidate && typeof candidate === "object"
      ? (candidate as SessionLifecycleSnapshot)
      : undefined;
  }

  private seedWorkerForTest(input: SessionSupervisorTestWorkerInput): void {
    const now = Date.now();
    const pending = new Map<string, PendingRequest>();
    for (const request of input.pendingRequests ?? []) {
      const deferred = runSyncAtBoundary(
        BrewvaDeferred.make<Record<string, unknown> | undefined, Error>(),
      );
      if (request.resolve || request.reject) {
        void runBoundaryOperation(
          "gateway.sessionSupervisor.testPendingRequest",
          BrewvaDeferred.await(deferred),
        ).then(
          (payload) => request.resolve?.(payload),
          (error: unknown) =>
            request.reject?.(error instanceof Error ? error : new Error(String(error))),
        );
      }
      pending.set(request.requestId, {
        deferred,
      });
    }

    const pendingCount = Math.max(0, input.pendingCount ?? 0);
    for (let index = pending.size; index < pendingCount; index += 1) {
      pending.set(`pending-${index}`, {
        deferred: runSyncAtBoundary(
          BrewvaDeferred.make<Record<string, unknown> | undefined, Error>(),
        ),
      });
    }

    const child = {
      pid: input.pid,
      send: () => true,
      on: () => undefined,
    } as unknown as ChildProcess;

    this.workers.set(input.sessionId, {
      sessionId: input.sessionId,
      scope: this.createWorkerScope(),
      child,
      startedAt: input.startedAt ?? now,
      lastActivityAt: input.lastActivityAt ?? now,
      cwd: input.cwd,
      requestedAgentSessionId: input.agentSessionId,
      pending,
      pendingTurns: new Map<string, PendingTurn>(),
      turnQueue: [],
      activeTurnId: input.activeTurnId ?? null,
      activeRecoveryWalIds: new Map<string, BrewvaWalId>(),
      readyRequestId: input.readyRequestId,
      lastHeartbeatAt: input.lastHeartbeatAt ?? now,
      lifecycleState:
        typeof input.activeTurnId === "string" && input.activeTurnId.length > 0
          ? createWorkerBusyState(
              String(child.pid ?? input.sessionId),
              input.sessionId,
              input.activeTurnId,
            )
          : createWorkerReadyState(String(child.pid ?? input.sessionId), input.sessionId),
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
    const workerModulePath = fileURLToPath(
      new URL("../../hosted/internal/turn-adapter/worker/main.js", import.meta.url),
    );
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
    void this.closeWorkerScope(handle);
  }

  private createWorkerScope(child?: ChildProcess): BrewvaScope.Closeable {
    const scope = runSyncAtBoundary(BrewvaScope.fork(this.supervisorScope));
    if (child) {
      runSyncAtBoundary(
        BrewvaScope.addFinalizer(
          scope,
          BrewvaEffect.promise(async () => {
            await terminatePid(child.pid ?? 0);
          }),
        ),
      );
    }
    return scope;
  }

  private async closeWorkerScope(handle: WorkerHandle): Promise<void> {
    try {
      await runBoundaryOperation(
        "gateway.sessionSupervisor.worker.closeScope",
        BrewvaScope.close(handle.scope, BrewvaExit.succeed(undefined)),
      );
    } catch (error) {
      this.options.logger.warn("failed to close worker scope", {
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    void input;
  }

  private ensureTerminalReceiptForHandle(handle: WorkerHandle, exit: WorkerExitInfo): void {
    this.ensureTerminalReceiptForRegistryEntry(
      {
        sessionId: handle.sessionId,
        pid: handle.child.pid ?? 0,
        startedAt: handle.startedAt,
        agentSessionId: handle.requestedAgentSessionId,
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
    if (this.pingLoop) {
      return;
    }

    this.pingLoop = startBoundaryInterval({
      intervalMs: BRIDGE_PING_INTERVAL_MS,
      run: () =>
        BrewvaEffect.sync(() => {
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
        }),
      onError: (error) => {
        this.options.logger.warn("worker heartbeat loop failed", {
          error: toErrorMessage(error),
        });
      },
    });
  }

  private startIdleSweep(): void {
    if (this.sessionIdleTtlMs <= 0 || this.idleSweepLoop) {
      return;
    }

    this.idleSweepLoop = startBoundaryInterval({
      intervalMs: this.sessionIdleSweepIntervalMs,
      run: () =>
        BrewvaEffect.tryPromise({
          try: () => this.sweepIdleSessions(),
          catch: (error) => error,
        }),
      onError: (error) => {
        this.options.logger.warn("idle session sweep failed", {
          error: toErrorMessage(error),
        });
      },
    });
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
    if (!this.recoveryWalStore?.isWalEnabled()) {
      return;
    }
    if (!this.options.recoveryWalContext) {
      throw new Error("recovery_wal_context_missing");
    }
    const recoveryWalScope = this.recoveryWalStore.getScope();
    const recovery = createRecoveryWalRecovery({
      workspaceRoot: this.options.recoveryWalContext.workspaceRoot,
      config: this.options.recoveryWalContext.config,
      scopeFilter: (scope) => scope === recoveryWalScope,
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
        scope: recoveryWalScope,
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
    if (!this.recoveryWalStore?.isWalEnabled() || this.recoveryWalCompactLoop) {
      return;
    }
    this.recoveryWalCompactLoop = startBoundaryInterval({
      intervalMs: this.recoveryWalCompactIntervalMs,
      run: () =>
        BrewvaEffect.sync(() => {
          const result = this.recoveryWalStore?.compact();
          if (result && result.dropped > 0) {
            this.options.logger.debug("Recovery WAL compacted", {
              scope: this.recoveryWalStore?.getScope(),
              scanned: result.scanned,
              retained: result.retained,
              dropped: result.dropped,
            });
          }
        }),
      onError: (error) => {
        this.options.logger.warn("Recovery WAL compaction failed", {
          error: toErrorMessage(error),
        });
      },
    });
  }

  private readRegistry(): ChildRegistryEntry[] {
    return this.stateStore.readChildrenRegistry(this.childrenRegistryPath);
  }

  private listSessionBindingsForReplay(sessionId: string): Array<{
    sessionId: string;
    agentSessionId: string;
    openedAt: number;
    cwd?: string;
  }> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return [];
    }

    const seen = new Set<string>();
    return listGatewaySessionBindings(this.sessionBindingStorePath, normalizedSessionId).flatMap(
      (entry) => {
        const key = `${entry.gatewaySessionId}::${entry.agentSessionId}::${entry.cwd ?? ""}`;
        if (seen.has(key)) {
          return [];
        }
        seen.add(key);
        return [
          {
            sessionId: entry.gatewaySessionId,
            agentSessionId: entry.agentSessionId,
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
