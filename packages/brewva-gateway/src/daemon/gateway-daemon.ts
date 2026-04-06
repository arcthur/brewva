import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import {
  BrewvaRuntime,
  SESSION_WIRE_SCHEMA,
  type ContextPressureView,
  type SessionWireFrame,
  type SessionWireStatusState,
  createTrustedLocalGovernancePort,
  loadBrewvaConfig,
  resolveWorkspaceRootDir,
  type ManagedToolMode,
} from "@brewva/brewva-runtime";
import {
  RecoveryWalStore,
  SchedulerService,
  createSchedulerIngressPort,
  recordRuntimeEvent,
} from "@brewva/brewva-runtime/internal";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { loadOrCreateGatewayToken, rotateGatewayToken } from "../auth.js";
import { assertLoopbackHost, normalizeGatewayHost } from "../network.js";
import type { GatewayErrorShape } from "../protocol/index.js";
import {
  ErrorCodes,
  type ConnectParams,
  type GatewayEvent,
  type GatewayMethod,
  type RequestFrame,
  GatewayEvents,
  GatewayMethods,
  PROTOCOL_VERSION,
  gatewayError,
} from "../protocol/index.js";
import {
  validateParamsForMethod,
  validateRequestFrame,
  validateSessionWireFramePayload,
} from "../protocol/validate.js";
import { FileGatewayStateStore, type GatewayStateStore } from "../state-store.js";
import { createDeferred } from "../utils/deferred.js";
import { toErrorMessage } from "../utils/errors.js";
import { safeParseJson } from "../utils/json.js";
import { rawToText } from "../utils/ws.js";
import { HeartbeatScheduler, type HeartbeatRule } from "./heartbeat-policy.js";
import { StructuredLogger } from "./logger.js";
import { readPidRecord, removePidRecord, writePidRecord, type GatewayPidRecord } from "./pid.js";
import { executeScheduleIntentRun } from "./schedule-runner.js";
import {
  isSessionBackendCapacityError,
  isSessionBackendStateError,
  type SessionBackend,
  type SessionWorkerInfo,
} from "./session-backend.js";
import { SessionSupervisor } from "./session-supervisor.js";
import {
  deriveSessionStatusSeedFromFrame,
  deriveSessionStatusSeedFromHistory,
  sameSessionStatusSeed,
  type SessionStatusSeed,
} from "./session-wire-status.js";

const DEFAULT_PORT = 43111;
const DEFAULT_TICK_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_TICK_INTERVAL_MS = 15_000;
const WEBSOCKET_CLOSE_TIMEOUT_MS = 3_000;
const HTTP_CLOSE_TIMEOUT_MS = 3_000;
const SESSION_SCOPED_EVENTS = new Set<GatewayEvent>(["session.wire.frame"]);

export type ConnectionPhase = "connected" | "authenticating" | "authenticated" | "closing";

interface ConnectionState {
  connId: string;
  socket: WebSocket;
  challengeNonce: string;
  phase: ConnectionPhase;
  authenticatedToken?: string;
  subscribedSessions: Set<string>;
  replayStateBySession: Map<
    string,
    {
      bufferedEvents: Array<{
        event: GatewayEvent;
        payload?: unknown;
        seq: number;
      }>;
    }
  >;
  replayDeliveredDurableFrameIdsBySession: Map<string, Set<string>>;
  connectedAt: number;
  lastSeenAt: number;
  client?: {
    id: string;
    version: string;
    mode?: string;
  };
}

interface SessionStatusSnapshot extends SessionStatusSeed {
  contextPressure?: ContextPressureView;
}

interface ReplayBufferedEvent {
  event: GatewayEvent;
  payload?: unknown;
  seq: number;
}

function isDurableSessionWireFrame(value: unknown): value is SessionWireFrame {
  const validated = validateSessionWireFramePayload(value);
  return validated.ok && validated.frame.durability === "durable";
}

function normalizeProjectedSessionWireFramePayload(
  payload: unknown,
): { ok: true; sessionId: string; frame: SessionWireFrame } | { ok: false; error: string } {
  if (payload && typeof payload === "object") {
    const outer = payload as { sessionId?: unknown; frame?: unknown };
    if (outer.frame && typeof outer.frame === "object") {
      const rawFrame = outer.frame as SessionWireFrame;
      const projectedSessionId =
        typeof outer.sessionId === "string" && outer.sessionId.trim().length > 0
          ? outer.sessionId.trim()
          : rawFrame.sessionId;
      const projectedFrame = projectSessionWireFrame(projectedSessionId, rawFrame);
      const validated = validateSessionWireFramePayload(projectedFrame);
      if (!validated.ok) {
        return validated;
      }
      return {
        ok: true,
        sessionId: projectedSessionId,
        frame: validated.frame,
      };
    }
  }
  const validated = validateSessionWireFramePayload(payload);
  if (!validated.ok) {
    return validated;
  }
  return {
    ok: true,
    sessionId: validated.frame.sessionId,
    frame: validated.frame,
  };
}

function rememberDeliveredReplayDurableFrame(
  replayDeliveredDurableFrameIdsBySession: ConnectionState["replayDeliveredDurableFrameIdsBySession"],
  sessionId: string,
  payload: unknown,
): boolean {
  if (!isDurableSessionWireFrame(payload)) {
    return true;
  }
  const tracker = replayDeliveredDurableFrameIdsBySession.get(sessionId);
  if (!tracker) {
    return true;
  }
  // Replay/live overlap dedupe must stay exact for the active replay window.
  // The tracker is scoped to replay only and cleared immediately after flush.
  if (tracker.has(payload.frameId)) {
    return false;
  }
  tracker.add(payload.frameId);
  return true;
}

function getReplayBufferedEvents(
  replayStateBySession: ConnectionState["replayStateBySession"],
  sessionId: string,
): ReplayBufferedEvent[] {
  return replayStateBySession.get(sessionId)?.bufferedEvents ?? [];
}

function readBufferedSessionWireFrames(
  bufferedEvents: readonly ReplayBufferedEvent[],
  sessionId: string,
): SessionWireFrame[] {
  const frames: SessionWireFrame[] = [];
  for (const entry of bufferedEvents) {
    if (entry.event !== "session.wire.frame") {
      continue;
    }
    const validated = validateSessionWireFramePayload(entry.payload);
    if (!validated.ok || validated.frame.sessionId !== sessionId) {
      continue;
    }
    frames.push(validated.frame);
  }
  return frames;
}

function findLastBufferedSessionStatusFrame(
  bufferedEvents: readonly ReplayBufferedEvent[],
  sessionId: string,
): Extract<SessionWireFrame, { type: "session.status" }> | null {
  for (let index = bufferedEvents.length - 1; index >= 0; index -= 1) {
    const entry = bufferedEvents[index];
    if (!entry || entry.event !== "session.wire.frame") {
      continue;
    }
    const validated = validateSessionWireFramePayload(entry.payload);
    if (!validated.ok || validated.frame.sessionId !== sessionId) {
      continue;
    }
    if (validated.frame.type === "session.status") {
      return validated.frame;
    }
  }
  return null;
}

function buildSessionStatusFrame(input: {
  sessionId: string;
  state: SessionWireStatusState;
  reason?: string;
  detail?: string;
  contextPressure?: ContextPressureView;
}): Extract<SessionWireFrame, { type: "session.status" }> {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: input.sessionId,
    frameId: `session.status:${input.sessionId}:${Date.now()}:${randomUUID()}`,
    ts: Date.now(),
    source: "live",
    durability: "cache",
    type: "session.status",
    state: input.state,
    reason: input.reason,
    detail: input.detail,
    contextPressure: input.contextPressure,
  };
}

function projectSessionWireFrame(sessionId: string, frame: SessionWireFrame): SessionWireFrame {
  if (frame.sessionId === sessionId) {
    return frame;
  }
  return {
    ...frame,
    sessionId,
  };
}

function buildReplayControlFrame(
  sessionId: string,
  type: Extract<SessionWireFrame["type"], "replay.begin" | "replay.complete">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId,
    frameId: `${type}:${sessionId}:${Date.now()}:${randomUUID()}`,
    ts: Date.now(),
    source: "replay",
    durability: "cache",
    type,
  };
}

function isGatewayErrorShape(value: unknown): value is GatewayErrorShape {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<GatewayErrorShape>;
  return typeof row.code === "string" && typeof row.message === "string";
}

function ensureDirectoryCwd(cwd: string): void {
  const resolved = resolve(cwd);
  if (!existsSync(resolved)) {
    throw new Error(`session cwd does not exist: ${resolved}`);
  }
  const stats = statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`session cwd is not a directory: ${resolved}`);
  }
}

function isConnectionAuthenticated(state: ConnectionState): boolean {
  return state.phase === "authenticated";
}

function normalizeTraceId(traceId: unknown): string | undefined {
  if (typeof traceId !== "string") {
    return undefined;
  }
  const normalized = traceId.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeHealthPath(pathRaw: string | undefined): string {
  if (typeof pathRaw !== "string") {
    return "/healthz";
  }
  const normalized = pathRaw.trim();
  if (!normalized) {
    return "/healthz";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export interface GatewayDaemonOptions {
  host?: string;
  port?: number;
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  heartbeatPolicyPath: string;
  cwd: string;
  configPath?: string;
  model?: string;
  managedToolMode?: ManagedToolMode;
  jsonStdout?: boolean;
  tickIntervalMs?: number;
  heartbeatTickIntervalMs?: number;
  sessionIdleTtlMs?: number;
  sessionIdleSweepIntervalMs?: number;
  maxWorkers?: number;
  maxPendingSessionOpens?: number;
  maxPayloadBytes?: number;
  healthHttpPort?: number;
  healthHttpPath?: string;
  sessionBackend?: SessionBackend;
  stateStore?: GatewayStateStore;
}

export interface GatewayRuntimeInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  heartbeatPolicyPath: string;
  healthHttpPort?: number;
  healthHttpPath?: string;
}

export interface GatewayHealthPayload {
  ok: true;
  pid: number;
  host: string;
  port: number;
  startedAt: number;
  uptimeMs: number;
  connections: number;
  workers: number;
}

export interface GatewayStatusDeepPayload extends GatewayHealthPayload {
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  healthHttpPort?: number;
  healthHttpPath?: string;
  heartbeat: ReturnType<HeartbeatScheduler["getStatus"]>;
  scheduler: {
    available: boolean;
    configEnabled: boolean;
    executionEnabled: boolean;
    paused: boolean;
    pausedAt?: number;
    reason?: string;
    unavailableReason?: "schedule_disabled" | "events_disabled";
    intentsTotal?: number;
    intentsActive?: number;
    timersArmed?: number;
    watermarkOffset?: number;
    projectionPath?: string;
  };
  workersDetail: SessionWorkerInfo[];
  connectionsDetail: Array<{
    connId: string;
    authenticated: boolean;
    phase: ConnectionPhase;
    connectedAt: number;
    lastSeenAt: number;
    subscribedSessions: string[];
    client?: {
      id: string;
      version: string;
      mode?: string;
    };
  }>;
}

export interface GatewayDaemonTestSocket {
  readyState: number;
  OPEN: number;
  CONNECTING: number;
  close(code: number, reason: string): void;
  terminate(): void;
  send(data: string): void;
}

export interface GatewayDaemonTestConnectionInput {
  connId?: string;
  socket?: GatewayDaemonTestSocket;
  challengeNonce?: string;
  phase?: ConnectionPhase;
  authenticatedToken?: string;
  subscribedSessions?: Iterable<string>;
  connectedAt?: number;
  lastSeenAt?: number;
  client?: {
    id: string;
    version: string;
    mode?: string;
  };
}

export interface GatewayDaemonTestConnectionSnapshot {
  connId: string;
  phase: ConnectionPhase;
  authenticatedToken?: string;
  subscribedSessions: string[];
  connectedAt: number;
  lastSeenAt: number;
  replaySessions: string[];
  replayDedupFrameCountsBySession: Record<string, number>;
}

export interface GatewayDaemonTestHooks {
  invokeMethod(
    method: GatewayMethod,
    params: unknown,
    state?: GatewayDaemonTestConnectionInput,
  ): Promise<unknown>;
  fireHeartbeat(rule: HeartbeatRule): Promise<void>;
  injectWorkerEvent(event: GatewayEvent, payload: unknown): void;
  observeBroadcasts(listener: (event: GatewayEvent, payload?: unknown) => void): () => void;
  getAuthToken(): string;
  getSessionBackend(): SessionBackend;
  registerConnection(input: GatewayDaemonTestConnectionInput): GatewayDaemonTestConnectionSnapshot;
  getConnectionSnapshot(connId: string): GatewayDaemonTestConnectionSnapshot | undefined;
  getSessionSubscriberIds(sessionId: string): string[];
}

export class GatewayDaemon {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly stateDir: string;
  private readonly pidFilePath: string;
  private readonly logFilePath: string;
  private readonly tokenFilePath: string;
  private readonly heartbeatPolicyPath: string;
  private readonly tickIntervalMs: number;
  private readonly maxPayloadBytes: number;
  private readonly configuredHealthHttpPort?: number;
  private readonly healthHttpPath: string;
  private authToken: string;
  private readonly stateStore: GatewayStateStore;
  private readonly logger: StructuredLogger;
  private readonly supervisor: SessionBackend;
  private readonly schedulerConfigEnabled: boolean;
  private readonly schedulerEventsEnabled: boolean;
  private readonly schedulerRuntime: BrewvaRuntime | null;
  private readonly scheduler: SchedulerService | null;
  private readonly schedulerUnavailableReason?: "schedule_disabled" | "events_disabled";
  private readonly recoveryWalStore?: RecoveryWalStore;
  private readonly heartbeatScheduler: HeartbeatScheduler;
  private readonly heartbeatSessionByRule = new Map<string, string>();
  private readonly broadcastObservers = new Set<(event: GatewayEvent, payload?: unknown) => void>();
  private readonly startedAt = Date.now();
  private readonly stopDeferred = createDeferred<void>();
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly connectionsById = new Map<string, ConnectionState>();
  private readonly sessionSubscribers = new Map<string, Set<string>>();
  private readonly sessionStatusBySession = new Map<string, SessionStatusSnapshot>();
  private readonly pendingSessionStatusBySession = new Map<string, SessionStatusSeed>();
  private readonly sessionStatusRevisionBySession = new Map<string, number>();

  private wss: WebSocketServer | null = null;
  private healthHttpServer: Server | null = null;
  private currentPort: number;
  private currentHealthHttpPort?: number;
  private eventSeq = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private ownsPidRecord = false;
  private onSigInt: (() => void) | null = null;
  private onSigTerm: (() => void) | null = null;
  private schedulerExecutionState: {
    paused: boolean;
    pausedAt?: number;
    reason?: string;
  } = {
    paused: false,
  };

  readonly testHooks: GatewayDaemonTestHooks = {
    invokeMethod: async (method, params, state) => {
      return await this.handleMethod(method, params, this.resolveConnectionStateForTest(state));
    },
    fireHeartbeat: async (rule) => {
      await this.fireHeartbeat(rule);
    },
    injectWorkerEvent: (event, payload) => {
      this.handleWorkerEvent(event, payload);
    },
    observeBroadcasts: (listener) => {
      this.broadcastObservers.add(listener);
      return () => {
        this.broadcastObservers.delete(listener);
      };
    },
    getAuthToken: () => this.authToken,
    getSessionBackend: () => this.supervisor,
    registerConnection: (input) => {
      const state = this.registerConnectionForTest(input);
      return this.toConnectionSnapshot(state)!;
    },
    getConnectionSnapshot: (connId) => {
      return this.toConnectionSnapshot(this.connectionsById.get(connId));
    },
    getSessionSubscriberIds: (sessionId) => {
      const normalizedSessionId = sessionId.trim();
      return [...(this.sessionSubscribers.get(normalizedSessionId) ?? new Set<string>())];
    },
  };

  constructor(private readonly options: GatewayDaemonOptions) {
    this.host = normalizeGatewayHost(options.host);
    assertLoopbackHost(this.host);

    this.configuredPort = Number.isInteger(options.port)
      ? Math.max(0, Number(options.port))
      : DEFAULT_PORT;
    this.currentPort = this.configuredPort;
    this.stateDir = resolve(options.stateDir);
    this.pidFilePath = resolve(options.pidFilePath);
    this.logFilePath = resolve(options.logFilePath);
    this.tokenFilePath = resolve(options.tokenFilePath);
    this.heartbeatPolicyPath = resolve(options.heartbeatPolicyPath);
    this.tickIntervalMs = Math.max(1000, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
    this.maxPayloadBytes = Math.max(
      16 * 1024,
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    );
    this.configuredHealthHttpPort =
      Number.isInteger(options.healthHttpPort) && Number(options.healthHttpPort) >= 0
        ? Number(options.healthHttpPort)
        : undefined;
    this.healthHttpPath = normalizeHealthPath(options.healthHttpPath);
    ensureDirectoryCwd(options.cwd);
    const resolvedCwd = resolve(options.cwd);
    const workspaceRoot = resolveWorkspaceRootDir(resolvedCwd);
    const runtimeConfig = loadBrewvaConfig({
      cwd: resolvedCwd,
      configPath: options.configPath,
    });
    this.stateStore =
      options.stateStore ??
      new FileGatewayStateStore(
        runtimeConfig.security.credentials.gatewayTokenRef
          ? {
              tokenVault: {
                vaultPath: resolve(workspaceRoot, runtimeConfig.security.credentials.path),
                credentialRef: runtimeConfig.security.credentials.gatewayTokenRef,
                masterKeyEnv: runtimeConfig.security.credentials.masterKeyEnv,
                allowDerivedKeyFallback: runtimeConfig.security.credentials.allowDerivedKeyFallback,
              },
            }
          : undefined,
      );
    this.recoveryWalStore = options.sessionBackend
      ? undefined
      : new RecoveryWalStore({
          workspaceRoot,
          config: runtimeConfig.infrastructure.recoveryWal,
          scope: "gateway",
        });
    this.authToken = loadOrCreateGatewayToken(this.tokenFilePath, this.stateStore);
    this.logger = new StructuredLogger({
      logFilePath: this.logFilePath,
      jsonStdout: options.jsonStdout === true,
    });

    this.supervisor =
      options.sessionBackend ??
      new SessionSupervisor({
        stateDir: this.stateDir,
        logger: this.logger,
        defaultCwd: resolve(options.cwd),
        defaultConfigPath: options.configPath,
        defaultModel: options.model,
        defaultManagedToolMode: options.managedToolMode,
        sessionIdleTtlMs: options.sessionIdleTtlMs,
        sessionIdleSweepIntervalMs: options.sessionIdleSweepIntervalMs,
        maxWorkers: options.maxWorkers,
        maxPendingSessionOpens: options.maxPendingSessionOpens,
        stateStore: this.stateStore,
        recoveryWalStore: this.recoveryWalStore,
        recoveryWalCompactIntervalMs: Math.max(
          30_000,
          Math.floor(runtimeConfig.infrastructure.recoveryWal.compactAfterMs / 2),
        ),
        onWorkerEvent: (event) => {
          this.handleWorkerEvent(event.event, event.payload);
        },
      });

    this.schedulerConfigEnabled = runtimeConfig.schedule.enabled;
    this.schedulerEventsEnabled = runtimeConfig.infrastructure.events.enabled;
    this.schedulerUnavailableReason = !this.schedulerConfigEnabled
      ? "schedule_disabled"
      : !this.schedulerEventsEnabled
        ? "events_disabled"
        : undefined;
    this.schedulerRuntime = !this.schedulerUnavailableReason
      ? new BrewvaRuntime({
          cwd: resolvedCwd,
          config: runtimeConfig,
          governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
        })
      : null;
    if (this.schedulerRuntime && !this.schedulerUnavailableReason) {
      const schedulerRuntime = this.schedulerRuntime;
      const schedulerIngress = createSchedulerIngressPort(schedulerRuntime);
      this.scheduler = new SchedulerService({
        runtime: {
          workspaceRoot: schedulerRuntime.workspaceRoot,
          scheduleConfig: schedulerRuntime.config.schedule,
          listSessionIds: () => schedulerRuntime.inspect.events.listSessionIds(),
          listEvents: (sessionId, query) => schedulerRuntime.inspect.events.list(sessionId, query),
          recordEvent: (input) => recordRuntimeEvent(schedulerRuntime, input),
          subscribeEvents: (listener) => schedulerRuntime.inspect.events.subscribe(listener),
          getTruthState: (sessionId) => schedulerRuntime.inspect.truth.getState(sessionId),
          getTaskState: (sessionId) => schedulerRuntime.inspect.task.getState(sessionId),
          recoveryWal: {
            appendPending: (envelope, source, walOptions) =>
              schedulerIngress.appendPending(envelope, source, walOptions),
            markInflight: (walId) => schedulerIngress.markInflight(walId),
            markDone: (walId) => schedulerIngress.markDone(walId),
            markFailed: (walId, error) => schedulerIngress.markFailed(walId, error),
            markExpired: (walId) => schedulerIngress.markExpired(walId),
            listPending: () => schedulerIngress.listPending(),
          },
        },
        shouldExecute: () => !this.schedulerExecutionState.paused,
        executeIntent: async (intent) => {
          return await executeScheduleIntentRun({
            runtime: schedulerRuntime,
            backend: this.supervisor,
            intent,
            cwd: resolvedCwd,
            configPath: options.configPath,
            model: options.model,
            managedToolMode: options.managedToolMode,
          });
        },
      });
    } else {
      this.scheduler = null;
    }

    this.heartbeatScheduler = new HeartbeatScheduler({
      sourcePath: this.heartbeatPolicyPath,
      logger: this.logger,
      tickIntervalMs:
        options.heartbeatTickIntervalMs !== undefined
          ? Math.max(1_000, options.heartbeatTickIntervalMs)
          : DEFAULT_HEARTBEAT_TICK_INTERVAL_MS,
      onFire: async (rule) => {
        await this.fireHeartbeat(rule);
      },
    });
    this.resetHeartbeatSessionMap(this.heartbeatScheduler.getStatus().rules);
  }

  async start(): Promise<void> {
    try {
      const pidRecord: GatewayPidRecord = {
        pid: process.pid,
        host: this.host,
        port: this.currentPort,
        startedAt: this.startedAt,
        cwd: resolve(this.options.cwd),
      };
      writePidRecord(this.pidFilePath, pidRecord);
      this.ownsPidRecord = true;

      await this.supervisor.start();
      if (this.scheduler) {
        await this.scheduler.recover();
      }
      this.heartbeatScheduler.start();
      this.startTickEmitter();
      this.installSignalHandlers();

      const wss = new WebSocketServer({
        host: this.host,
        port: this.configuredPort,
        maxPayload: this.maxPayloadBytes,
      });

      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: Error): void => {
          wss.off("listening", onListening);
          rejectStart(error);
        };
        const onListening = (): void => {
          wss.off("error", onError);
          resolveStart();
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
      });

      wss.on("connection", (socket: WebSocket) => {
        this.onConnection(socket);
      });
      wss.on("error", (error: Error) => {
        this.logger.error("gateway websocket server error", { error: error.message });
      });
      this.wss = wss;

      const address = wss.address();
      if (address && typeof address === "object") {
        this.currentPort = address.port;
      }

      if (this.configuredHealthHttpPort !== undefined) {
        const healthServer = createServer((request, response) => {
          this.handleHealthHttpRequest(request, response);
        });

        await new Promise<void>((resolveStart, rejectStart) => {
          const onError = (error: Error): void => {
            healthServer.off("listening", onListening);
            rejectStart(error);
          };
          const onListening = (): void => {
            healthServer.off("error", onError);
            resolveStart();
          };
          healthServer.once("error", onError);
          healthServer.once("listening", onListening);
          healthServer.listen(this.configuredHealthHttpPort, this.host);
        });

        healthServer.on("error", (error: Error) => {
          this.logger.warn("gateway health http server error", {
            error: error.message,
          });
        });

        this.healthHttpServer = healthServer;
        const healthAddress = healthServer.address();
        if (healthAddress && typeof healthAddress === "object") {
          this.currentHealthHttpPort = healthAddress.port;
        }
      }

      this.logger.info("gateway daemon started", {
        pid: process.pid,
        host: this.host,
        port: this.currentPort,
        healthHttpPort: this.currentHealthHttpPort,
        healthHttpPath: this.currentHealthHttpPort ? this.healthHttpPath : undefined,
        stateDir: this.stateDir,
        heartbeatPolicyPath: this.heartbeatPolicyPath,
        protocol: PROTOCOL_VERSION,
      });
    } catch (error) {
      await this.cleanupFailedStart();
      throw error;
    }
  }

  getRuntimeInfo(): GatewayRuntimeInfo {
    return {
      pid: process.pid,
      host: this.host,
      port: this.currentPort,
      startedAt: this.startedAt,
      stateDir: this.stateDir,
      pidFilePath: this.pidFilePath,
      logFilePath: this.logFilePath,
      heartbeatPolicyPath: this.heartbeatPolicyPath,
      healthHttpPort: this.currentHealthHttpPort,
      healthHttpPath: this.currentHealthHttpPort ? this.healthHttpPath : undefined,
    };
  }

  getHealthStatus(): GatewayHealthPayload {
    return {
      ok: true,
      pid: process.pid,
      host: this.host,
      port: this.currentPort,
      startedAt: this.startedAt,
      uptimeMs: Math.max(0, Date.now() - this.startedAt),
      connections: [...this.connections.values()].filter((value) =>
        isConnectionAuthenticated(value),
      ).length,
      workers: this.supervisor.listWorkers().length,
    };
  }

  getDeepStatus(): GatewayStatusDeepPayload {
    return {
      ...this.getHealthStatus(),
      stateDir: this.stateDir,
      pidFilePath: this.pidFilePath,
      logFilePath: this.logFilePath,
      tokenFilePath: this.tokenFilePath,
      healthHttpPort: this.currentHealthHttpPort,
      healthHttpPath: this.currentHealthHttpPort ? this.healthHttpPath : undefined,
      heartbeat: this.heartbeatScheduler.getStatus(),
      scheduler: this.getSchedulerStatus(),
      workersDetail: this.supervisor.listWorkers(),
      connectionsDetail: [...this.connections.values()].map((value) => ({
        connId: value.connId,
        authenticated: isConnectionAuthenticated(value),
        phase: value.phase,
        connectedAt: value.connectedAt,
        lastSeenAt: value.lastSeenAt,
        subscribedSessions: [...value.subscribedSessions],
        client: value.client,
      })),
    };
  }

  async waitForStop(): Promise<void> {
    await this.stopDeferred.promise;
  }

  async stop(reason = "shutdown"): Promise<void> {
    if (this.stopping) {
      await this.stopDeferred.promise;
      return;
    }
    this.stopping = true;

    this.logger.info("gateway daemon stopping", { reason });
    this.broadcastEvent("shutdown", {
      reason,
      ts: Date.now(),
    });

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.scheduler?.stop();
    this.heartbeatScheduler.stop();
    try {
      await this.supervisor.stop();
    } catch {
      // best effort; continue cleanup
    }

    if (this.wss) {
      const server = this.wss;
      this.wss = null;

      for (const state of Array.from(this.connections.values())) {
        this.cleanupConnectionState(state);
        try {
          state.socket.terminate();
        } catch {
          // best effort
        }
      }
      this.connections.clear();
      this.connectionsById.clear();
      this.sessionSubscribers.clear();

      await this.closeWebSocketServer(server, WEBSOCKET_CLOSE_TIMEOUT_MS);
    }

    if (this.healthHttpServer) {
      const healthServer = this.healthHttpServer;
      this.healthHttpServer = null;
      this.currentHealthHttpPort = undefined;
      await this.closeHttpServer(healthServer, HTTP_CLOSE_TIMEOUT_MS);
    }

    this.uninstallSignalHandlers();
    this.removeOwnedPidRecordIfPresent();
    this.logger.info("gateway daemon stopped", { reason });
    this.stopDeferred.resolve(undefined);
  }

  private installSignalHandlers(): void {
    if (!this.onSigInt) {
      this.onSigInt = () => {
        void this.stop("sigint");
      };
      process.on("SIGINT", this.onSigInt);
    }
    if (!this.onSigTerm) {
      this.onSigTerm = () => {
        void this.stop("sigterm");
      };
      process.on("SIGTERM", this.onSigTerm);
    }
  }

  private uninstallSignalHandlers(): void {
    if (this.onSigInt) {
      process.off("SIGINT", this.onSigInt);
      this.onSigInt = null;
    }
    if (this.onSigTerm) {
      process.off("SIGTERM", this.onSigTerm);
      this.onSigTerm = null;
    }
  }

  private async cleanupFailedStart(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.heartbeatScheduler.stop();

    if (this.wss) {
      const server = this.wss;
      this.wss = null;
      await this.closeWebSocketServer(server, WEBSOCKET_CLOSE_TIMEOUT_MS);
    }

    if (this.healthHttpServer) {
      const healthServer = this.healthHttpServer;
      this.healthHttpServer = null;
      this.currentHealthHttpPort = undefined;
      await this.closeHttpServer(healthServer, HTTP_CLOSE_TIMEOUT_MS);
    }

    await this.supervisor.stop().catch(() => undefined);
    this.uninstallSignalHandlers();
    this.removeOwnedPidRecordIfPresent();
  }

  private removeOwnedPidRecordIfPresent(): void {
    if (!this.ownsPidRecord) {
      return;
    }
    const currentRecord = readPidRecord(this.pidFilePath);
    if (currentRecord?.pid === process.pid) {
      removePidRecord(this.pidFilePath);
    }
    this.ownsPidRecord = false;
  }

  private startTickEmitter(): void {
    if (this.tickTimer) {
      return;
    }

    this.tickTimer = setInterval(() => {
      this.broadcastEvent("tick", {
        ts: Date.now(),
        workers: this.supervisor.listWorkers().length,
        connections: [...this.connections.values()].filter((value) =>
          isConnectionAuthenticated(value),
        ).length,
      });
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  private async closeWebSocketServer(server: WebSocketServer, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveClose();
      };

      const timer = setTimeout(
        () => {
          this.logger.warn("gateway websocket close timeout", {
            timeoutMs,
            clients: server.clients.size,
          });
          finish();
        },
        Math.max(200, timeoutMs),
      );
      timer.unref?.();

      try {
        server.close(() => {
          clearTimeout(timer);
          finish();
        });
      } catch (error) {
        clearTimeout(timer);
        this.logger.warn("gateway websocket close threw error", {
          error: error instanceof Error ? error.message : String(error),
        });
        finish();
      }
    });
  }

  private async closeHttpServer(server: Server, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolveClose();
      };

      const timer = setTimeout(
        () => {
          this.logger.warn("gateway health http close timeout", { timeoutMs });
          finish();
        },
        Math.max(200, timeoutMs),
      );
      timer.unref?.();

      try {
        server.close((error) => {
          clearTimeout(timer);
          if (error) {
            this.logger.warn("gateway health http close error", {
              error: error.message,
            });
          }
          finish();
        });
      } catch (error) {
        clearTimeout(timer);
        this.logger.warn("gateway health http close threw error", {
          error: error instanceof Error ? error.message : String(error),
        });
        finish();
      }
    });
  }

  private handleHealthHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    const requestMethod = request.method ?? "GET";
    if (requestMethod !== "GET" && requestMethod !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: false, error: "method_not_allowed" }));
      return;
    }

    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (requestPath !== this.healthHttpPath) {
      response.statusCode = 404;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (requestMethod === "HEAD") {
      response.end();
      return;
    }
    response.end(
      JSON.stringify({
        schema: "brewva.gateway.health-http.v1",
        ...this.getHealthStatus(),
        path: this.healthHttpPath,
      }),
    );
  }

  private nextEventSeq(): number {
    this.eventSeq += 1;
    return this.eventSeq;
  }

  private onConnection(socket: WebSocket): void {
    const state: ConnectionState = {
      connId: randomUUID(),
      socket,
      challengeNonce: randomUUID(),
      phase: "connected",
      subscribedSessions: new Set<string>(),
      replayStateBySession: new Map(),
      replayDeliveredDurableFrameIdsBySession: new Map(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.connections.set(socket, state);
    this.connectionsById.set(state.connId, state);

    socket.on("message", (raw: RawData) => {
      void this.handleIncomingMessage(state, raw);
    });
    socket.on("close", () => {
      this.cleanupConnectionState(state);
    });
    socket.on("error", (error: Error) => {
      this.logger.warn("connection error", {
        connId: state.connId,
        error: error.message,
      });
    });

    this.sendEvent(state, "connect.challenge", {
      nonce: state.challengeNonce,
      ts: Date.now(),
    });
  }

  private async handleIncomingMessage(state: ConnectionState, raw: RawData): Promise<void> {
    state.lastSeenAt = Date.now();
    const text = rawToText(raw);
    const parsedRaw = safeParseJson(text);
    if (!validateRequestFrame(parsedRaw)) {
      const id =
        parsedRaw &&
        typeof parsedRaw === "object" &&
        typeof (parsedRaw as { id?: unknown }).id === "string"
          ? (parsedRaw as { id: string }).id
          : randomUUID();
      this.logger.debug("invalid request frame", { connId: state.connId });
      this.sendResponse(state, {
        id,
        ok: false,
        traceId: undefined,
        error: gatewayError(
          ErrorCodes.INVALID_REQUEST,
          "invalid request frame; expected {type:'req',id,method,params}",
        ),
      });
      return;
    }

    const request = parsedRaw as RequestFrame;
    const methodRaw = request.method;
    if (!GatewayMethods.includes(methodRaw as GatewayMethod)) {
      this.logger.debug("unknown method", { connId: state.connId, method: methodRaw });
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId: normalizeTraceId(request.traceId),
        error: gatewayError(ErrorCodes.METHOD_NOT_FOUND, `method not found: ${methodRaw}`),
      });
      return;
    }
    const method = methodRaw as GatewayMethod;
    const traceId = normalizeTraceId(request.traceId);

    if (state.phase === "closing") {
      this.logger.debug("request on closing connection", { connId: state.connId, method });
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.BAD_STATE, "connection is closing"),
      });
      return;
    }

    if (method !== "connect" && !isConnectionAuthenticated(state)) {
      this.logger.debug("unauthenticated request", { connId: state.connId, method });
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.UNAUTHORIZED, "call connect first"),
      });
      return;
    }

    if (method === "connect" && isConnectionAuthenticated(state)) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.BAD_STATE, "connection already authenticated"),
      });
      return;
    }

    if (
      method !== "connect" &&
      isConnectionAuthenticated(state) &&
      state.authenticatedToken !== this.authToken
    ) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.UNAUTHORIZED, "invalid token"),
      });
      this.closeConnection(state, 1008, "auth token rotated");
      return;
    }

    const validated = validateParamsForMethod(method, request.params ?? {});
    if (!validated.ok) {
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: gatewayError(ErrorCodes.INVALID_REQUEST, validated.error),
      });
      return;
    }

    const startedAt = Date.now();
    this.logger.debug("gateway request received", {
      connId: state.connId,
      method,
      requestId: request.id,
      traceId,
      phase: state.phase,
    });

    try {
      const payload = await this.handleMethod(method, validated.params, state);
      this.sendResponse(state, {
        id: request.id,
        ok: true,
        traceId,
        payload,
      });
      this.logger.debug("gateway request completed", {
        connId: state.connId,
        method,
        requestId: request.id,
        traceId,
        latencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      const shaped = isGatewayErrorShape(error)
        ? error
        : gatewayError(ErrorCodes.INTERNAL, toErrorMessage(error));
      this.sendResponse(state, {
        id: request.id,
        ok: false,
        traceId,
        error: shaped,
      });
      this.logger.warn("gateway request failed", {
        connId: state.connId,
        method,
        requestId: request.id,
        traceId,
        latencyMs: Date.now() - startedAt,
        errorCode: shaped.code,
        errorMessage: shaped.message,
      });
    }
  }

  private async handleMethod(
    method: GatewayMethod,
    params: unknown,
    state: ConnectionState,
  ): Promise<unknown> {
    switch (method) {
      case "connect":
        return this.handleConnect(params as ConnectParams, state);
      case "health":
        return this.getHealthStatus();
      case "status.deep":
        return this.getDeepStatus();
      case "scheduler.pause": {
        const input = params as { reason?: string };
        return this.pauseScheduler(input.reason);
      }
      case "scheduler.resume":
        return this.resumeScheduler();
      case "sessions.open": {
        const input = params as {
          sessionId?: string;
          cwd?: string;
          configPath?: string;
          model?: string;
          agentId?: string;
          managedToolMode?: ManagedToolMode;
        };
        const requestedSessionId = input.sessionId?.trim() || randomUUID();
        if (input.cwd) {
          ensureDirectoryCwd(input.cwd);
        }
        let result: Awaited<ReturnType<SessionBackend["openSession"]>>;
        try {
          result = await this.supervisor.openSession({
            sessionId: requestedSessionId,
            cwd: input.cwd ? resolve(input.cwd) : undefined,
            configPath: input.configPath,
            model: input.model,
            agentId: input.agentId,
            managedToolMode: input.managedToolMode,
          });
        } catch (error) {
          if (isSessionBackendCapacityError(error)) {
            throw gatewayError(ErrorCodes.BAD_STATE, error.message, {
              retryable: error.code === "worker_limit",
              details: {
                kind: error.code,
                ...error.details,
              },
            });
          }
          throw error;
        }
        if (result.created) {
          this.noteSessionOpened(requestedSessionId);
        }
        return {
          ...result,
          requestedSessionId,
        };
      }
      case "sessions.subscribe": {
        const input = params as { sessionId: string };
        const sessionId = input.sessionId.trim();
        await this.subscribeAndReplaySession(state, sessionId);
        return {
          sessionId,
          subscribed: true,
        };
      }
      case "sessions.unsubscribe": {
        const input = params as { sessionId: string };
        const sessionId = input.sessionId.trim();
        const unsubscribed = this.unsubscribeConnectionFromSession(state, sessionId);
        return {
          sessionId,
          unsubscribed,
        };
      }
      case "sessions.send": {
        const input = params as {
          sessionId: string;
          prompt: string;
          turnId?: string;
        };
        const sessionId = input.sessionId.trim();
        this.subscribeConnectionToSession(state, sessionId);

        let payload: Awaited<ReturnType<SessionBackend["sendPrompt"]>>;
        try {
          payload = await this.supervisor.sendPrompt(sessionId, input.prompt, {
            turnId: input.turnId,
            waitForCompletion: false,
            source: "gateway",
          });
        } catch (error) {
          if (isSessionBackendStateError(error)) {
            throw gatewayError(ErrorCodes.BAD_STATE, toErrorMessage(error), {
              retryable: false,
              details: {
                kind: error.code,
              },
            });
          }
          throw error;
        }

        return {
          sessionId: payload.sessionId,
          agentSessionId: payload.agentSessionId,
          turnId: payload.turnId,
          accepted: payload.accepted,
        };
      }
      case "sessions.abort": {
        const input = params as { sessionId: string; reason?: "user_submit" };
        const aborted = await this.supervisor.abortSession(input.sessionId, input.reason);
        return {
          sessionId: input.sessionId,
          aborted,
        };
      }
      case "sessions.close": {
        const input = params as { sessionId: string };
        const closed = await this.supervisor.stopSession(input.sessionId, "remote_close");
        return {
          sessionId: input.sessionId,
          closed,
        };
      }
      case "heartbeat.reload": {
        const { policy, removedRuleIds, closedSessionIds } =
          await this.reloadHeartbeatPolicyAndCleanupSessions();
        return {
          sourcePath: policy.sourcePath,
          loadedAt: policy.loadedAt,
          rules: policy.rules.length,
          removedRules: removedRuleIds.length,
          closedSessions: closedSessionIds.length,
          removedRuleIds,
          closedSessionIds,
        };
      }
      case "gateway.rotate-token": {
        const previousToken = this.authToken;
        const rotatedAt = Date.now();
        const nextToken = rotateGatewayToken(this.tokenFilePath, this.stateStore);

        this.authToken = nextToken;
        const revokedConnections =
          previousToken && previousToken !== nextToken
            ? this.revokeAuthenticatedConnections(previousToken)
            : 0;

        this.logger.info("gateway auth token rotated", {
          connId: state.connId,
          rotatedAt,
          revokedConnections,
        });
        return {
          rotated: true,
          rotatedAt,
          revokedConnections,
        };
      }
      case "gateway.stop": {
        const input = params as { reason?: string };
        const reason = input.reason?.trim() || "remote_stop";
        setTimeout(() => {
          void this.stop(reason);
        }, 10).unref?.();
        return {
          stopping: true,
          reason,
        };
      }
      default:
        throw gatewayError(ErrorCodes.METHOD_NOT_FOUND, `method not found: ${String(method)}`);
    }
  }

  private handleConnect(params: ConnectParams, state: ConnectionState): unknown {
    state.phase = "authenticating";
    if (params.protocol !== PROTOCOL_VERSION) {
      state.phase = "connected";
      throw gatewayError(
        ErrorCodes.INVALID_REQUEST,
        `protocol mismatch: server=${PROTOCOL_VERSION}, client=${params.protocol}`,
      );
    }

    if (params.challengeNonce !== state.challengeNonce) {
      state.phase = "connected";
      throw gatewayError(
        ErrorCodes.UNAUTHORIZED,
        "challenge nonce mismatch; call connect.challenge first",
      );
    }

    const token = params.auth.token;
    if (token !== this.authToken) {
      state.phase = "connected";
      throw gatewayError(ErrorCodes.UNAUTHORIZED, "invalid token");
    }

    state.phase = "authenticated";
    state.authenticatedToken = token;
    state.client = {
      id: params.client.id,
      version: params.client.version,
      mode: params.client.mode,
    };

    return {
      type: "hello-ok",
      protocol: PROTOCOL_VERSION,
      server: {
        version: "0.1.0",
        connId: state.connId,
        pid: process.pid,
      },
      features: {
        methods: [...GatewayMethods],
        events: [...GatewayEvents],
      },
      policy: {
        maxPayloadBytes: this.maxPayloadBytes,
        tickIntervalMs: this.tickIntervalMs,
      },
    };
  }

  private getSchedulerStatus(): GatewayStatusDeepPayload["scheduler"] {
    const stats = this.scheduler?.getStats();
    return {
      available: this.scheduler !== null,
      configEnabled: this.schedulerConfigEnabled,
      executionEnabled: stats?.executionEnabled ?? false,
      paused: this.schedulerExecutionState.paused,
      pausedAt: this.schedulerExecutionState.pausedAt,
      reason: this.schedulerExecutionState.reason,
      unavailableReason: this.scheduler ? undefined : this.schedulerUnavailableReason,
      intentsTotal: stats?.intentsTotal,
      intentsActive: stats?.intentsActive,
      timersArmed: stats?.timersArmed,
      watermarkOffset: stats?.watermarkOffset,
      projectionPath: stats?.projectionPath,
    };
  }

  private pauseScheduler(reasonRaw?: string): {
    paused: boolean;
    changed: boolean;
    available: boolean;
    pausedAt: number | null;
    reason: string | null;
    unavailableReason?: "schedule_disabled" | "events_disabled";
  } {
    if (!this.scheduler) {
      return {
        paused: false,
        changed: false,
        available: false,
        pausedAt: null,
        reason: null,
        unavailableReason: this.schedulerUnavailableReason,
      };
    }
    if (!this.schedulerExecutionState.paused) {
      this.schedulerExecutionState = {
        paused: true,
        pausedAt: Date.now(),
        reason:
          typeof reasonRaw === "string" && reasonRaw.trim().length > 0
            ? reasonRaw.trim()
            : undefined,
      };
      this.scheduler.syncExecutionState();
      return {
        paused: true,
        changed: true,
        available: true,
        pausedAt: this.schedulerExecutionState.pausedAt ?? null,
        reason: this.schedulerExecutionState.reason ?? null,
      };
    }
    return {
      paused: true,
      changed: false,
      available: true,
      pausedAt: this.schedulerExecutionState.pausedAt ?? null,
      reason: this.schedulerExecutionState.reason ?? null,
    };
  }

  private resumeScheduler(): {
    paused: boolean;
    changed: boolean;
    available: boolean;
    pausedAt: null;
    reason: null;
    previousPausedAt: number | null;
    previousReason: string | null;
    unavailableReason?: "schedule_disabled" | "events_disabled";
  } {
    if (!this.scheduler) {
      return {
        paused: false,
        changed: false,
        available: false,
        pausedAt: null,
        reason: null,
        previousPausedAt: null,
        previousReason: null,
        unavailableReason: this.schedulerUnavailableReason,
      };
    }
    const previousPausedAt = this.schedulerExecutionState.pausedAt ?? null;
    const previousReason = this.schedulerExecutionState.reason ?? null;
    if (!this.schedulerExecutionState.paused) {
      return {
        paused: false,
        changed: false,
        available: true,
        pausedAt: null,
        reason: null,
        previousPausedAt,
        previousReason,
      };
    }
    this.schedulerExecutionState = {
      paused: false,
    };
    this.scheduler.syncExecutionState();
    return {
      paused: false,
      changed: true,
      available: true,
      pausedAt: null,
      reason: null,
      previousPausedAt,
      previousReason,
    };
  }

  private async fireHeartbeat(rule: HeartbeatRule): Promise<void> {
    const sessionId =
      this.heartbeatSessionByRule.get(rule.id) ?? this.resolveHeartbeatSessionId(rule);
    this.heartbeatSessionByRule.set(rule.id, sessionId);
    const heartbeatPrompt = rule.prompt.trim();
    const opened = await this.supervisor.openSession({ sessionId });
    if (opened.created) {
      this.noteSessionOpened(sessionId);
    }
    const result = await this.supervisor.sendPrompt(sessionId, heartbeatPrompt, {
      waitForCompletion: true,
      source: "heartbeat",
    });

    this.broadcastEvent("heartbeat.fired", {
      ruleId: rule.id,
      sessionId,
      ts: Date.now(),
      hasResult: result.output !== undefined,
    });
  }

  private resolveHeartbeatSessionId(input: { id: string; sessionId?: string }): string {
    const explicitSessionId = input.sessionId?.trim();
    if (explicitSessionId) {
      return explicitSessionId;
    }
    return `heartbeat:${input.id}`;
  }

  private isDefaultHeartbeatSessionId(ruleId: string, sessionId: string): boolean {
    return sessionId === `heartbeat:${ruleId}`;
  }

  private resetHeartbeatSessionMap(rules: ReadonlyArray<{ id: string; sessionId?: string }>): void {
    this.heartbeatSessionByRule.clear();
    for (const rule of rules) {
      this.heartbeatSessionByRule.set(rule.id, this.resolveHeartbeatSessionId(rule));
    }
  }

  private async reloadHeartbeatPolicyAndCleanupSessions(): Promise<{
    policy: ReturnType<HeartbeatScheduler["reload"]>;
    removedRuleIds: string[];
    closedSessionIds: string[];
  }> {
    const previousSessionByRule = new Map(this.heartbeatSessionByRule);
    const policy = this.heartbeatScheduler.reload();
    this.resetHeartbeatSessionMap(policy.rules);

    const activeRuleIds = new Set(this.heartbeatSessionByRule.keys());
    const activeSessionIds = new Set(this.heartbeatSessionByRule.values());
    const removedRuleIds: string[] = [];
    const cleanupCandidates = new Set<string>();

    for (const [ruleId, previousSessionId] of previousSessionByRule.entries()) {
      if (!activeRuleIds.has(ruleId)) {
        removedRuleIds.push(ruleId);
        if (this.isDefaultHeartbeatSessionId(ruleId, previousSessionId)) {
          cleanupCandidates.add(previousSessionId);
        }
        continue;
      }

      const currentSessionId = this.heartbeatSessionByRule.get(ruleId);
      if (
        currentSessionId &&
        currentSessionId !== previousSessionId &&
        this.isDefaultHeartbeatSessionId(ruleId, previousSessionId)
      ) {
        cleanupCandidates.add(previousSessionId);
      }
    }

    const closedSessionIds: string[] = [];
    for (const sessionId of cleanupCandidates) {
      if (activeSessionIds.has(sessionId)) {
        continue;
      }
      const closed = await this.supervisor.stopSession(sessionId, "heartbeat_rule_removed");
      if (closed) {
        closedSessionIds.push(sessionId);
      }
    }

    if (removedRuleIds.length > 0 || closedSessionIds.length > 0) {
      this.logger.info("heartbeat policy cleanup completed", {
        removedRuleIds,
        closedSessionIds,
      });
    }

    return {
      policy,
      removedRuleIds,
      closedSessionIds,
    };
  }

  private handleWorkerEvent(event: GatewayEvent, payload: unknown): void {
    if (!SESSION_SCOPED_EVENTS.has(event)) {
      return;
    }
    if (event === "session.wire.frame") {
      const normalizedFrame = normalizeProjectedSessionWireFramePayload(payload);
      if (!normalizedFrame.ok) {
        this.logger.warn("dropping invalid session wire frame from worker", {
          error: normalizedFrame.error,
        });
        return;
      }
      this.broadcastSessionEvent(event, normalizedFrame.frame, normalizedFrame.sessionId);
      this.transitionSessionStatusFromWirePayload(normalizedFrame.frame);
      return;
    }
    const sessionId = this.extractSessionIdFromPayload(payload);
    if (!sessionId) {
      this.logger.warn("dropping session-scoped event without sessionId", { event });
      return;
    }
    this.broadcastSessionEvent(event, payload, sessionId);
  }

  private extractSessionIdFromPayload(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const sessionId = (payload as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && sessionId.trim()) {
      return sessionId.trim();
    }
    const nestedFrame = (payload as { frame?: unknown }).frame;
    if (nestedFrame && typeof nestedFrame === "object") {
      const nestedSessionId = (nestedFrame as { sessionId?: unknown }).sessionId;
      if (typeof nestedSessionId === "string" && nestedSessionId.trim()) {
        return nestedSessionId.trim();
      }
    }
    return undefined;
  }

  private resolveSessionStatusState(sessionId: string): SessionWireStatusState {
    const worker = this.supervisor
      .listWorkers()
      .find((candidate) => candidate.sessionId === sessionId);
    if (!worker) {
      return "idle";
    }
    return worker.pendingRequests > 0 ? "running" : "idle";
  }

  private async querySessionContextPressure(
    sessionId: string,
  ): Promise<ContextPressureView | undefined> {
    try {
      return await this.supervisor.querySessionContextPressure(sessionId);
    } catch (error) {
      this.logger.warn("session context pressure query failed", {
        sessionId,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  private async buildSessionStatusFrameForSession(input: {
    sessionId: string;
    state: SessionWireStatusState;
    reason?: string;
    detail?: string;
  }): Promise<Extract<SessionWireFrame, { type: "session.status" }>> {
    return buildSessionStatusFrame({
      ...input,
      contextPressure: await this.querySessionContextPressure(input.sessionId),
    });
  }

  private clearSessionStatusTracking(sessionId: string): void {
    this.sessionStatusBySession.delete(sessionId);
    this.pendingSessionStatusBySession.delete(sessionId);
    this.sessionStatusRevisionBySession.delete(sessionId);
  }

  private noteSessionOpened(sessionId: string): void {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    this.clearSessionStatusTracking(normalizedSessionId);
    if ((this.sessionSubscribers.get(normalizedSessionId)?.size ?? 0) === 0) {
      return;
    }
    this.transitionSessionStatus(normalizedSessionId, {
      state: "idle",
    });
  }

  private transitionSessionStatus(sessionId: string, seed: SessionStatusSeed): void {
    const current = this.sessionStatusBySession.get(sessionId);
    const pending = this.pendingSessionStatusBySession.get(sessionId);
    const matchesCurrent = sameSessionStatusSeed(current, seed);
    const matchesPending = sameSessionStatusSeed(pending, seed);
    if (matchesCurrent && (pending === undefined || matchesPending)) {
      return;
    }
    const nextRevision = (this.sessionStatusRevisionBySession.get(sessionId) ?? 0) + 1;
    this.sessionStatusRevisionBySession.set(sessionId, nextRevision);
    if ((this.sessionSubscribers.get(sessionId)?.size ?? 0) === 0) {
      this.clearSessionStatusTracking(sessionId);
      return;
    }
    if (matchesCurrent) {
      this.pendingSessionStatusBySession.delete(sessionId);
      return;
    }
    this.pendingSessionStatusBySession.set(sessionId, seed);

    // Context-pressure sampling is best-effort. Under rapid state churn we
    // prefer dropping stale async snapshots over emitting out-of-order status
    // frames, even if that means the surviving status carries slightly older
    // pressure data for one transition window.
    void this.buildSessionStatusFrameForSession({
      sessionId,
      ...seed,
    })
      .then((statusFrame) => {
        if ((this.sessionStatusRevisionBySession.get(sessionId) ?? 0) !== nextRevision) {
          return;
        }
        this.pendingSessionStatusBySession.delete(sessionId);
        this.sessionStatusBySession.set(sessionId, {
          ...seed,
          contextPressure: statusFrame.contextPressure,
        });
        this.broadcastSessionEvent("session.wire.frame", statusFrame, sessionId);
      })
      .catch((error) => {
        this.logger.warn("session status transition failed", {
          sessionId,
          error: toErrorMessage(error),
        });
      });
  }

  private transitionSessionStatusFromWirePayload(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const typedFrame = payload as SessionWireFrame;
    const seed = deriveSessionStatusSeedFromFrame(typedFrame);
    if (!seed) {
      return;
    }
    this.transitionSessionStatus(typedFrame.sessionId, seed);
  }

  private startSessionReplay(state: ConnectionState, sessionId: string): void {
    state.replayStateBySession.set(sessionId, {
      bufferedEvents: [],
    });
    state.replayDeliveredDurableFrameIdsBySession.set(sessionId, new Set());
  }

  private flushSessionReplay(state: ConnectionState, sessionId: string): ReplayBufferedEvent[] {
    const buffered = [...getReplayBufferedEvents(state.replayStateBySession, sessionId)];
    state.replayStateBySession.delete(sessionId);
    for (const entry of buffered) {
      this.sendSessionEvent(state, sessionId, entry.event, entry.payload, entry.seq);
    }
    state.replayDeliveredDurableFrameIdsBySession.delete(sessionId);
    return buffered;
  }

  private async subscribeAndReplaySession(
    state: ConnectionState,
    sessionId: string,
  ): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    const added = this.subscribeConnectionToSession(state, normalizedSessionId);
    if (!added) {
      return;
    }

    this.startSessionReplay(state, normalizedSessionId);
    try {
      this.sendEvent(
        state,
        "session.wire.frame",
        buildReplayControlFrame(normalizedSessionId, "replay.begin"),
      );
      let frames: SessionWireFrame[] = [];
      try {
        frames = await this.supervisor.querySessionWire(normalizedSessionId);
      } catch (error) {
        this.logger.warn("session wire replay query failed", {
          sessionId: normalizedSessionId,
          error: toErrorMessage(error),
        });
      }
      const publicFrames = frames.map((frame) =>
        projectSessionWireFrame(normalizedSessionId, frame),
      );
      for (const frame of publicFrames) {
        this.sendSessionEvent(state, normalizedSessionId, "session.wire.frame", frame);
      }
      this.sendEvent(
        state,
        "session.wire.frame",
        buildReplayControlFrame(normalizedSessionId, "replay.complete"),
      );
      const bufferedReplayWindowEvents = this.flushSessionReplay(state, normalizedSessionId);
      if (
        !findLastBufferedSessionStatusFrame(bufferedReplayWindowEvents, normalizedSessionId) &&
        !this.pendingSessionStatusBySession.has(normalizedSessionId)
      ) {
        const statusRevision = this.sessionStatusRevisionBySession.get(normalizedSessionId) ?? 0;
        const statusSeed =
          this.sessionStatusBySession.get(normalizedSessionId) ??
          deriveSessionStatusSeedFromHistory(
            normalizedSessionId,
            [
              ...publicFrames,
              ...readBufferedSessionWireFrames(bufferedReplayWindowEvents, normalizedSessionId),
            ],
            this.resolveSessionStatusState(normalizedSessionId),
          );
        const statusFrame = await this.buildSessionStatusFrameForSession({
          sessionId: normalizedSessionId,
          ...statusSeed,
        });
        if (
          (this.sessionStatusRevisionBySession.get(normalizedSessionId) ?? 0) !== statusRevision
        ) {
          return;
        }
        this.sendEvent(state, "session.wire.frame", statusFrame);
        if (!this.sessionStatusBySession.has(normalizedSessionId)) {
          this.sessionStatusBySession.set(normalizedSessionId, {
            ...statusSeed,
            contextPressure: statusFrame.contextPressure,
          });
        }
      }
    } finally {
      if (state.replayStateBySession.has(normalizedSessionId)) {
        this.flushSessionReplay(state, normalizedSessionId);
      }
    }
  }

  private subscribeConnectionToSession(state: ConnectionState, sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return false;
    }
    if (state.subscribedSessions.has(normalizedSessionId)) {
      return false;
    }
    state.subscribedSessions.add(normalizedSessionId);
    const subscribers = this.sessionSubscribers.get(normalizedSessionId);
    if (subscribers) {
      subscribers.add(state.connId);
    } else {
      this.sessionSubscribers.set(normalizedSessionId, new Set([state.connId]));
    }
    return true;
  }

  private unsubscribeConnectionFromSession(state: ConnectionState, sessionId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || !state.subscribedSessions.has(normalizedSessionId)) {
      return false;
    }
    state.subscribedSessions.delete(normalizedSessionId);
    state.replayStateBySession.delete(normalizedSessionId);
    state.replayDeliveredDurableFrameIdsBySession.delete(normalizedSessionId);
    const subscribers = this.sessionSubscribers.get(normalizedSessionId);
    if (subscribers) {
      subscribers.delete(state.connId);
      if (subscribers.size === 0) {
        this.sessionSubscribers.delete(normalizedSessionId);
        this.clearSessionStatusTracking(normalizedSessionId);
      }
    }
    return true;
  }

  private cleanupConnectionState(state: ConnectionState): void {
    this.transitionConnectionToClosing(state);
    this.connections.delete(state.socket);
    this.connectionsById.delete(state.connId);
  }

  private transitionConnectionToClosing(state: ConnectionState): void {
    if (state.phase === "closing") {
      return;
    }
    state.phase = "closing";
    for (const sessionId of Array.from(state.subscribedSessions)) {
      this.unsubscribeConnectionFromSession(state, sessionId);
    }
  }

  private broadcastSessionEvent(event: GatewayEvent, payload: unknown, sessionId: string): void {
    const subscriberIds = this.sessionSubscribers.get(sessionId);
    if (!subscriberIds || subscriberIds.size === 0) {
      return;
    }

    const seq = this.nextEventSeq();
    for (const connId of Array.from(subscriberIds)) {
      const state = this.connectionsById.get(connId);
      if (!state || !isConnectionAuthenticated(state)) {
        subscriberIds.delete(connId);
        continue;
      }
      const replayState = state.replayStateBySession.get(sessionId);
      if (replayState) {
        replayState.bufferedEvents.push({
          event,
          payload,
          seq,
        });
        continue;
      }
      this.sendSessionEvent(state, sessionId, event, payload, seq);
    }
    if (subscriberIds.size === 0) {
      this.sessionSubscribers.delete(sessionId);
    }
  }

  private revokeAuthenticatedConnections(token: string): number {
    let revokedConnections = 0;
    for (const state of this.connections.values()) {
      if (!isConnectionAuthenticated(state) || state.authenticatedToken !== token) {
        continue;
      }
      revokedConnections += 1;
      this.closeConnection(state, 1008, "auth token rotated");
    }
    return revokedConnections;
  }

  private closeConnection(state: ConnectionState, code: number, reason: string): void {
    this.transitionConnectionToClosing(state);
    setTimeout(() => {
      if (
        state.socket.readyState !== state.socket.OPEN &&
        state.socket.readyState !== state.socket.CONNECTING
      ) {
        return;
      }
      try {
        state.socket.close(code, reason);
      } catch {
        state.socket.terminate();
      }
    }, 10).unref?.();
  }

  private sendResponse(
    state: ConnectionState,
    payload: {
      id: string;
      ok: boolean;
      traceId?: string;
      payload?: unknown;
      error?: GatewayErrorShape;
    },
  ): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }

    const frame = {
      type: "res",
      id: payload.id,
      traceId: payload.traceId,
      ok: payload.ok,
      payload: payload.payload,
      error: payload.error,
    };
    state.socket.send(JSON.stringify(frame));
  }

  private sendEvent(
    state: ConnectionState,
    event: GatewayEvent,
    payload?: unknown,
    seq?: number,
  ): void {
    if (state.socket.readyState !== state.socket.OPEN) {
      return;
    }
    const frame = {
      type: "event",
      event,
      payload,
      seq: seq ?? this.nextEventSeq(),
    };
    state.socket.send(JSON.stringify(frame));
  }

  private sendSessionEvent(
    state: ConnectionState,
    sessionId: string,
    event: GatewayEvent,
    payload?: unknown,
    seq?: number,
  ): void {
    if (
      event === "session.wire.frame" &&
      !rememberDeliveredReplayDurableFrame(
        state.replayDeliveredDurableFrameIdsBySession,
        sessionId,
        payload,
      )
    ) {
      return;
    }
    this.sendEvent(state, event, payload, seq);
  }

  private broadcastEvent(event: GatewayEvent, payload?: unknown): void {
    for (const observer of this.broadcastObservers) {
      try {
        observer(event, payload);
      } catch (error) {
        this.logger.warn("gateway broadcast observer failed", {
          event,
          error: toErrorMessage(error),
        });
      }
    }
    if (SESSION_SCOPED_EVENTS.has(event)) {
      const sessionId = this.extractSessionIdFromPayload(payload);
      if (sessionId) {
        this.broadcastSessionEvent(event, payload, sessionId);
      } else {
        this.logger.warn("skipping scoped event broadcast without sessionId", { event });
      }
      return;
    }
    const seq = this.nextEventSeq();
    for (const state of this.connections.values()) {
      if (!isConnectionAuthenticated(state) && event !== "connect.challenge") {
        continue;
      }
      this.sendEvent(state, event, payload, seq);
    }
  }

  private createSocketForTest(socket?: GatewayDaemonTestSocket): WebSocket {
    const fallback: GatewayDaemonTestSocket = socket ?? {
      readyState: 1,
      OPEN: 1,
      CONNECTING: 0,
      close: () => undefined,
      terminate: () => undefined,
      send: () => undefined,
    };
    return fallback as unknown as WebSocket;
  }

  private createConnectionStateForTest(
    input: GatewayDaemonTestConnectionInput = {},
  ): ConnectionState {
    const now = Date.now();
    return {
      connId: input.connId?.trim() || randomUUID(),
      socket: this.createSocketForTest(input.socket),
      challengeNonce: input.challengeNonce ?? `test-challenge-${randomUUID()}`,
      phase: input.phase ?? "authenticated",
      authenticatedToken: input.authenticatedToken,
      subscribedSessions: new Set<string>(),
      replayStateBySession: new Map(),
      replayDeliveredDurableFrameIdsBySession: new Map(),
      connectedAt: input.connectedAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      client: input.client,
    };
  }

  private registerConnectionForTest(input: GatewayDaemonTestConnectionInput): ConnectionState {
    const state = this.createConnectionStateForTest(input);
    this.connections.set(state.socket, state);
    this.connectionsById.set(state.connId, state);
    for (const sessionId of input.subscribedSessions ?? []) {
      this.subscribeConnectionToSession(state, sessionId);
    }
    return state;
  }

  private resolveConnectionStateForTest(input?: GatewayDaemonTestConnectionInput): ConnectionState {
    if (input?.connId) {
      const existing = this.connectionsById.get(input.connId.trim());
      if (existing) {
        return existing;
      }
    }
    return this.createConnectionStateForTest(input);
  }

  private toConnectionSnapshot(
    state: ConnectionState | undefined,
  ): GatewayDaemonTestConnectionSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    return {
      connId: state.connId,
      phase: state.phase,
      authenticatedToken: state.authenticatedToken,
      subscribedSessions: [...state.subscribedSessions],
      connectedAt: state.connectedAt,
      lastSeenAt: state.lastSeenAt,
      replaySessions: [...state.replayStateBySession.keys()],
      replayDedupFrameCountsBySession: Object.fromEntries(
        [...state.replayDeliveredDurableFrameIdsBySession.entries()].map(([sessionId, tracker]) => [
          sessionId,
          tracker.size,
        ]),
      ),
    };
  }
}

export async function runGatewayDaemon(options: GatewayDaemonOptions): Promise<void> {
  const daemon = new GatewayDaemon(options);
  await daemon.start();
  await daemon.waitForStop();
}
