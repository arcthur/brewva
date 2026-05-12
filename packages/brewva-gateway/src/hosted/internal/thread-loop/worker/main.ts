import {
  BrewvaEffect,
  BrewvaWorkerScope,
  runEdgeOperation,
  startScopedSchedule,
  type ScopedScheduleHandle,
} from "@brewva/brewva-effect";
import { type ContextStatusView, type SessionWireFrame } from "@brewva/brewva-runtime";
import { recordSessionShutdownIfMissing } from "../../../../utils/runtime.js";
import {
  createHostedSession as createGatewaySession,
  type HostedSessionResult as GatewaySessionResult,
} from "../../session/init/session-assembly.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import { createRuntimeTurnClockStore } from "../lifecycle/runtime-turn-clock.js";
import { resolveWorkerSessionShutdownReceipt } from "../shutdown-receipts.js";
import { createMinimalThreadLoopDiagnostic } from "../state.js";
import { runHostedTurnEnvelope, type HostedTurnEnvelopeLoopResult } from "../turn-envelope.js";
import { recordSessionTurnTransition } from "../turn-transition.js";
import { TaskProgressWatchdog } from "../watchdog/task-progress-watchdog.js";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "./protocol.js";
import { createSessionWireRelayGate } from "./relay-gate.js";
import { resolveWorkerTestHarness, type ResolvedWorkerTestHarness } from "./test-harness.js";

const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 4_000;

let requestedSessionId = "";
let expectedParentPid = 0;
let initialized = false;
let sessionResult: GatewaySessionResult | null = null;
let lastPingAt = Date.now();
let watchdog: ScopedScheduleHandle | null = null;
let heartbeatTicker: ScopedScheduleHandle | null = null;
let taskProgressWatchdog: TaskProgressWatchdog | null = null;
let shuttingDown = false;
let activeTurnId: string | null = null;
let pendingUserCancellationTurnId: string | null = null;
let unsubscribeSessionWire: (() => void) | null = null;
const sessionWireRelayGate = createSessionWireRelayGate();
const workerTurnClock = createRuntimeTurnClockStore();
let workerTestHarness: ResolvedWorkerTestHarness = {
  enabled: false,
  watchdog: {},
};
type WorkerLogLevel = Extract<WorkerToParentMessage, { kind: "log" }>["level"];

const hostedSessionLogger: HostedSessionLogger = {
  warn(message, fields) {
    log("warn", message, fields);
  },
};

function summarizeFakeAssistantMessage(
  assistantText: string,
  timestamp: number,
): {
  role: "assistant";
  timestamp: number;
  stopReason: "end_turn";
  provider: null;
  model: null;
  usage: null;
  contentItems: number;
  contentTextChars: number;
} {
  return {
    role: "assistant",
    timestamp,
    stopReason: "end_turn",
    provider: null,
    model: null,
    usage: null,
    contentItems: assistantText.length > 0 ? 1 : 0,
    contentTextChars: assistantText.length,
  };
}

function recordFakeTurnLifecycle(
  agentSessionId: string,
  turnId: string,
  assistantText: string,
): void {
  if (!sessionResult) {
    return;
  }

  const runtime = sessionResult.runtime;
  const existingSessionStart = runtime.inspect.events.query(agentSessionId, {
    type: "session_start",
  });
  if (existingSessionStart.length === 0) {
    runtime.extensions.hosted.events.record({
      sessionId: agentSessionId,
      type: "session_start",
      payload: {
        cwd: runtime.workspaceRoot,
      },
    });
  }

  const existingAgentStart = runtime.inspect.events.query(agentSessionId, {
    type: "agent_start",
  });
  if (existingAgentStart.length === 0) {
    runtime.extensions.hosted.events.record({
      sessionId: agentSessionId,
      type: "agent_start",
    });
  }

  const timestamp = Date.now();
  const localTurn = runtime.inspect.events.query(agentSessionId, {
    type: "turn_start",
  }).length;
  const runtimeTurn = workerTurnClock.observeTurnStart(agentSessionId, localTurn, timestamp);
  const message = summarizeFakeAssistantMessage(assistantText, timestamp);

  runtime.maintain.context.onTurnStart(agentSessionId, runtimeTurn);
  runtime.extensions.hosted.events.record({
    sessionId: agentSessionId,
    type: "turn_start",
    turn: runtimeTurn,
    payload: {
      localTurn,
      timestamp,
    },
  });
  runtime.extensions.hosted.events.record({
    sessionId: agentSessionId,
    type: "message_start",
    payload: message,
  });
  runtime.extensions.hosted.events.record({
    sessionId: agentSessionId,
    type: "message_end",
    payload: message,
  });
  runtime.maintain.context.onTurnEnd(agentSessionId);
  runtime.extensions.hosted.events.record({
    sessionId: agentSessionId,
    type: "turn_end",
    turn: runtimeTurn,
    payload: {
      localTurn,
      message,
      toolResults: 0,
    },
  });
  runtime.extensions.hosted.events.record({
    sessionId: agentSessionId,
    type: "agent_end",
    payload: {
      messageCount: 1,
      costSummary: runtime.inspect.cost.getSummary(agentSessionId),
    },
  });
}

function send(message: WorkerToParentMessage): void {
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message);
}

function sendSessionWireFrame(sessionId: string, frame: SessionWireFrame): void {
  send({
    kind: "event",
    event: "session.wire.frame",
    payload: {
      sessionId,
      frame,
    },
  });
}

function projectSessionContextStatus(sessionId: string): ContextStatusView | undefined {
  if (!sessionResult) {
    return undefined;
  }
  const usage = sessionResult.runtime.inspect.context.getUsage(sessionId);
  if (typeof usage?.tokens !== "number" || !Number.isFinite(usage.tokens)) {
    return undefined;
  }
  if (typeof usage.contextWindow !== "number" || !Number.isFinite(usage.contextWindow)) {
    return undefined;
  }
  const tokensTotal = Math.max(0, usage.contextWindow);
  if (tokensTotal <= 0) {
    return undefined;
  }
  const contextStatus = sessionResult.runtime.inspect.context.getStatus(sessionId, usage);
  if (
    contextStatus.usageRatio === null ||
    contextStatus.tokensRemaining === null ||
    contextStatus.tokensUntilForcedCompact === null ||
    contextStatus.tokensUntilPredictedOverflow === null
  ) {
    return undefined;
  }
  return {
    tokensUsed: Math.max(0, usage.tokens),
    tokensTotal,
    effectiveTokensTotal: contextStatus.effectiveTokensTotal,
    tokensRemaining: contextStatus.tokensRemaining,
    autoCompactLimitTokens: contextStatus.autoCompactLimitTokens,
    controllableBaselineTokens: contextStatus.controllableBaselineTokens,
    controllableTokensUsed: contextStatus.controllableTokensUsed ?? undefined,
    controllableTokensTotal: contextStatus.controllableTokensTotal,
    controllableTokensRemaining: contextStatus.controllableTokensRemaining ?? undefined,
    controllableContextRemainingRatio: contextStatus.controllableContextRemainingRatio,
    tokensUntilForcedCompact: contextStatus.tokensUntilForcedCompact,
    predictedTurnGrowthTokens: contextStatus.predictedTurnGrowthTokens,
    tokensUntilPredictedOverflow: contextStatus.tokensUntilPredictedOverflow,
    predictedOverflow: contextStatus.predictedOverflow,
    usageRatio: contextStatus.usageRatio,
    hardLimitRatio: contextStatus.hardLimitRatio,
    compactionThresholdRatio: contextStatus.compactionThresholdRatio,
    compactionAdvised: contextStatus.compactionAdvised,
    forcedCompaction: contextStatus.forcedCompaction,
  };
}

function log(level: WorkerLogLevel, message: string, fields?: Record<string, unknown>): void {
  send({
    kind: "log",
    level,
    message,
    fields,
  });
}

function normalizeShutdownReason(reason: string): string {
  const normalized = reason.trim();
  return normalized.length > 0 ? normalized : "shutdown";
}

async function shutdown(exitCode = 0, reason = "shutdown", shutdownError?: unknown): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await stopBridgeWatchdog();

  if (sessionResult) {
    const runtime = sessionResult.runtime;
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    const shutdownReason = normalizeShutdownReason(reason);
    const shutdownReceipt = resolveWorkerSessionShutdownReceipt(shutdownReason);
    recordSessionShutdownIfMissing(runtime, {
      sessionId: agentSessionId,
      reason: shutdownReceipt.reason,
      source: shutdownReceipt.source,
      error: shutdownError,
    });
    unsubscribeSessionWire?.();
    unsubscribeSessionWire = null;
    const interruptReason =
      shutdownReason === "bridge_timeout"
        ? ("timeout_interrupt" as const)
        : shutdownReason === "sigterm" || shutdownReason === "sigint"
          ? ("signal_interrupt" as const)
          : null;
    const finalizeInterruptTransition = (
      status: "completed" | "failed",
      transitionError?: string,
    ): void => {
      if (!interruptReason) {
        return;
      }
      recordSessionTurnTransition(runtime, {
        sessionId: agentSessionId,
        reason: interruptReason,
        status,
        family: "interrupt",
        error: transitionError?.trim().length ? transitionError : undefined,
      });
    };
    if (interruptReason === "timeout_interrupt") {
      recordSessionTurnTransition(runtime, {
        sessionId: agentSessionId,
        reason: interruptReason,
        status: "entered",
        family: "interrupt",
        error: shutdownReason,
      });
    } else if (interruptReason === "signal_interrupt") {
      recordSessionTurnTransition(runtime, {
        sessionId: agentSessionId,
        reason: interruptReason,
        status: "entered",
        family: "interrupt",
        error: shutdownReason,
      });
    }
    await taskProgressWatchdog?.stop();
    taskProgressWatchdog = null;
    try {
      await sessionResult.session.abort();
      finalizeInterruptTransition("completed");
    } catch (abortError) {
      finalizeInterruptTransition(
        "failed",
        abortError instanceof Error ? abortError.message : String(abortError),
      );
    }
    try {
      sessionResult.session.dispose();
    } catch {
      return;
    }
    workerTurnClock.clearSession(agentSessionId);
    sessionResult = null;
  }

  log("info", "worker exiting", { reason, exitCode, requestedSessionId });
  process.exit(exitCode);
}

function startBridgeWatchdog(): void {
  if (watchdog) return;

  watchdog = startScopedSchedule({
    intervalMs: 1000,
    run: () =>
      BrewvaEffect.sync(() => {
        const now = Date.now();
        if (now - lastPingAt > BRIDGE_TIMEOUT_MS) {
          void shutdown(1, "bridge_timeout");
          return;
        }

        if (expectedParentPid > 0 && process.ppid !== expectedParentPid) {
          void shutdown(1, "parent_pid_mismatch");
        }
      }),
  });

  heartbeatTicker = startScopedSchedule({
    intervalMs: BRIDGE_HEARTBEAT_INTERVAL_MS,
    run: () =>
      BrewvaEffect.sync(() => {
        send({ kind: "bridge.heartbeat", ts: Date.now() });
      }),
  });
}

async function stopBridgeWatchdog(): Promise<void> {
  const handles = [watchdog, heartbeatTicker].filter(
    (handle): handle is ScopedScheduleHandle => handle !== null,
  );
  watchdog = null;
  heartbeatTicker = null;
  await Promise.all(handles.map((handle) => handle.close()));
}

async function handleInit(
  message: Extract<ParentToWorkerMessage, { kind: "init" }>,
): Promise<void> {
  if (initialized) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker already initialized",
    });
    return;
  }

  initialized = true;
  requestedSessionId = message.payload.sessionId;
  expectedParentPid = message.payload.parentPid;
  workerTestHarness = resolveWorkerTestHarness();

  try {
    sessionResult = await createGatewaySession({
      cwd: message.payload.cwd,
      configPath: message.payload.configPath,
      model: message.payload.model,
      agentId: message.payload.agentId,
      managedToolMode: message.payload.managedToolMode,
      logger: hostedSessionLogger,
    });
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    const agentEventLogPath =
      sessionResult.runtime.extensions.hosted.events.resolveLogPath(agentSessionId);
    const watchdogOverrides = workerTestHarness.watchdog;
    if (watchdogOverrides.taskGoal) {
      sessionResult.runtime.authority.task.setSpec(agentSessionId, {
        schema: "brewva.task.v1",
        goal: watchdogOverrides.taskGoal,
      });
    }
    process.title = `brewva-worker:${requestedSessionId}`;
    lastPingAt = Date.now();
    startBridgeWatchdog();
    taskProgressWatchdog = new TaskProgressWatchdog({
      runtime: sessionResult.runtime,
      sessionId: agentSessionId,
      pollIntervalMs: watchdogOverrides.pollIntervalMs,
      thresholdMs: watchdogOverrides.thresholdMs,
    });
    taskProgressWatchdog.start();
    unsubscribeSessionWire = sessionResult.runtime.inspect.sessionWire.subscribe(
      agentSessionId,
      (frame) => {
        if (sessionWireRelayGate.isPaused()) {
          return;
        }
        sendSessionWireFrame(requestedSessionId, frame);
      },
    );
    send({
      kind: "ready",
      requestId: message.requestId,
      payload: {
        requestedSessionId,
        agentSessionId,
        agentEventLogPath,
      },
    });

    log("info", "worker initialized", {
      requestedSessionId,
      agentSessionId,
      parentPid: expectedParentPid,
    });
  } catch (error) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    await shutdown(1, "init_failed", error);
  }
}

async function handleSend(
  message: Extract<ParentToWorkerMessage, { kind: "send" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker session not initialized",
    });
    return;
  }

  if (activeTurnId) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: `session is busy with active turn: ${activeTurnId}`,
      errorCode: "session_busy",
    });
    return;
  }

  const candidateTurnId = message.payload.turnId.trim();
  const turnId = candidateTurnId || message.requestId;
  activeTurnId = turnId;
  const agentSessionId = sessionResult.session.sessionManager.getSessionId();

  send({
    kind: "result",
    requestId: message.requestId,
    ok: true,
    payload: {
      sessionId: requestedSessionId,
      agentSessionId,
      turnId,
      accepted: true,
    },
  });

  void runTurn({
    turnId,
    prompt: message.payload.prompt,
    agentSessionId,
    walReplayId: message.payload.walReplayId,
    trigger: message.payload.trigger,
    source: message.payload.source,
  });
}

async function runTurn(input: {
  turnId: string;
  prompt: string;
  agentSessionId: string;
  walReplayId?: string;
  trigger?: Extract<ParentToWorkerMessage, { kind: "send" }>["payload"]["trigger"];
  source?: "gateway" | "heartbeat" | "schedule";
}): Promise<void> {
  if (!sessionResult) {
    activeTurnId = null;
    return;
  }
  const releaseSessionWireRelay = sessionWireRelayGate.pause();
  try {
    const fakeAssistantText = workerTestHarness.fakeAssistantText;
    await runHostedTurnEnvelope({
      session: sessionResult.session,
      runtime: sessionResult.runtime,
      sessionId: input.agentSessionId,
      prompt: input.prompt,
      turnId: input.turnId,
      source: input.source ?? "gateway",
      trigger: input.trigger,
      walReplayId: input.walReplayId,
      onFrame: (frame) => {
        sendSessionWireFrame(requestedSessionId, frame);
      },
      classifyThrownError: () =>
        pendingUserCancellationTurnId === input.turnId ? "cancelled" : "failed",
      runLoop: fakeAssistantText
        ? async (loopInput): Promise<HostedTurnEnvelopeLoopResult> => {
            recordFakeTurnLifecycle(input.agentSessionId, input.turnId, fakeAssistantText);
            return {
              status: "completed",
              attemptId: "attempt-1",
              assistantText: fakeAssistantText,
              toolOutputs: [],
              diagnostic: createMinimalThreadLoopDiagnostic({
                sessionId: input.agentSessionId,
                turnId: input.turnId,
                profile: loopInput.profile.name,
              }),
            };
          }
        : undefined,
    });
  } catch (error) {
    log("error", "worker turn envelope failed", {
      requestedSessionId,
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (pendingUserCancellationTurnId === input.turnId) {
      pendingUserCancellationTurnId = null;
    }
    releaseSessionWireRelay();
    activeTurnId = null;
  }
}

async function handleAbort(
  message: Extract<ParentToWorkerMessage, { kind: "abort" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker session not initialized",
    });
    return;
  }

  try {
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    const shouldRecordUserSubmitInterrupt =
      message.payload?.reason === "user_submit" && activeTurnId !== null;
    if (shouldRecordUserSubmitInterrupt && activeTurnId) {
      pendingUserCancellationTurnId = activeTurnId;
    }
    if (shouldRecordUserSubmitInterrupt) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: agentSessionId,
        reason: "user_submit_interrupt",
        status: "entered",
        family: "interrupt",
      });
    }
    await sessionResult.session.abort();
    if (shouldRecordUserSubmitInterrupt) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: agentSessionId,
        reason: "user_submit_interrupt",
        status: "completed",
        family: "interrupt",
      });
    }
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload: {
        sessionId: requestedSessionId,
        aborted: true,
      },
    });
  } catch (error) {
    if (message.payload?.reason === "user_submit" && activeTurnId !== null) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: sessionResult.session.sessionManager.getSessionId(),
        reason: "user_submit_interrupt",
        status: "failed",
        family: "interrupt",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSteer(
  message: Extract<ParentToWorkerMessage, { kind: "steer" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: "worker session not initialized",
    });
    return;
  }

  try {
    const outcome = await sessionResult.session.steer(message.payload.text, { source: "gateway" });
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload:
        outcome.status === "queued"
          ? { status: outcome.status, chars: outcome.chars }
          : { status: outcome.status },
    });
  } catch (error) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSessionContextStatusQuery(
  message: Extract<ParentToWorkerMessage, { kind: "sessionContextStatus.query" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload: {
        contextStatus: undefined,
      },
    });
    return;
  }

  const agentSessionId = sessionResult.session.sessionManager.getSessionId();
  send({
    kind: "result",
    requestId: message.requestId,
    ok: true,
    payload: {
      contextStatus: projectSessionContextStatus(agentSessionId),
    },
  });
}

async function handleSessionLifecycleQuery(
  message: Extract<ParentToWorkerMessage, { kind: "sessionLifecycle.query" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload: {
        lifecycle: undefined,
      },
    });
    return;
  }

  const agentSessionId = sessionResult.session.sessionManager.getSessionId();
  send({
    kind: "result",
    requestId: message.requestId,
    ok: true,
    payload: {
      lifecycle: sessionResult.runtime.inspect.lifecycle.getSnapshot(agentSessionId),
    },
  });
}

async function handleMessage(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const message = raw as {
    kind?: unknown;
    requestId?: unknown;
    payload?: unknown;
  };
  const kind = typeof message.kind === "string" ? message.kind : "";
  if (kind === "bridge.ping") {
    lastPingAt = Date.now();
    return;
  }

  if (kind === "init") {
    await handleInit(raw as Extract<ParentToWorkerMessage, { kind: "init" }>);
    return;
  }

  if (!initialized) {
    const requestId = typeof message.requestId === "string" ? message.requestId : "unknown";
    send({
      kind: "result",
      requestId,
      ok: false,
      error: "worker is not initialized",
    });
    return;
  }

  if (kind === "send") {
    await handleSend(raw as Extract<ParentToWorkerMessage, { kind: "send" }>);
    return;
  }

  if (kind === "abort") {
    await handleAbort(raw as Extract<ParentToWorkerMessage, { kind: "abort" }>);
    return;
  }

  if (kind === "steer") {
    await handleSteer(raw as Extract<ParentToWorkerMessage, { kind: "steer" }>);
    return;
  }

  if (kind === "sessionContextStatus.query") {
    await handleSessionContextStatusQuery(
      raw as Extract<ParentToWorkerMessage, { kind: "sessionContextStatus.query" }>,
    );
    return;
  }

  if (kind === "sessionLifecycle.query") {
    await handleSessionLifecycleQuery(
      raw as Extract<ParentToWorkerMessage, { kind: "sessionLifecycle.query" }>,
    );
    return;
  }

  if (kind === "shutdown") {
    const shutdownMessage = raw as Extract<ParentToWorkerMessage, { kind: "shutdown" }>;
    const requestId = shutdownMessage.requestId;
    send({
      kind: "result",
      requestId,
      ok: true,
      payload: {
        sessionId: requestedSessionId,
        stopped: true,
      },
    });
    await shutdown(0, shutdownMessage.payload?.reason ?? "shutdown_requested");
  }
}

function resolveWorkerMessageKind(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "invalid";
  }
  const kind = (raw as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : "unknown";
}

function workerScopeFields(): { sessionId: string; pid: number } {
  return {
    sessionId: requestedSessionId || "uninitialized",
    pid: process.pid,
  };
}

export function handleWorkerMessageEffect(raw: unknown): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() => handleMessage(raw));
}

function shutdownEffect(
  exitCode: number,
  reason: string,
  shutdownError?: unknown,
): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() => shutdown(exitCode, reason, shutdownError));
}

function logWorkerEdgeFailure(operation: string, error: unknown): void {
  log("error", "worker edge operation failed", {
    requestedSessionId,
    operation,
    error: error instanceof Error ? error.message : String(error),
  });
}

function runWorkerEdgeOperation(
  operation: string,
  effect: BrewvaEffect.Effect<void, unknown>,
): Promise<void> {
  const scope = workerScopeFields();
  return runEdgeOperation(
    `brewva.gateway.worker.${operation}`,
    effect.pipe(BrewvaEffect.provide(BrewvaWorkerScope.layer(scope))),
    {
      fields: {
        operation,
        requestedSessionId: scope.sessionId,
        activeTurnId,
        pid: scope.pid,
      },
    },
  );
}

function handleFatalProcessError(operation: string, message: string, reason: unknown): void {
  log("error", message, {
    requestedSessionId,
    error: reason instanceof Error ? reason.message : String(reason),
  });
  void runWorkerEdgeOperation(operation, shutdownEffect(1, operation, reason)).catch((error) => {
    logWorkerEdgeFailure(operation, error);
  });
}

process.on("message", (message) => {
  const operation = `message.${resolveWorkerMessageKind(message)}`;
  void runWorkerEdgeOperation(operation, handleWorkerMessageEffect(message)).catch((error) => {
    logWorkerEdgeFailure(operation, error);
  });
});

process.on("disconnect", () => {
  void runWorkerEdgeOperation("disconnect", shutdownEffect(0, "parent_disconnected")).catch(
    (error) => {
      logWorkerEdgeFailure("disconnect", error);
    },
  );
});

process.on("SIGTERM", () => {
  void runWorkerEdgeOperation("signal.sigterm", shutdownEffect(0, "sigterm")).catch((error) => {
    logWorkerEdgeFailure("signal.sigterm", error);
  });
});

process.on("SIGINT", () => {
  void runWorkerEdgeOperation("signal.sigint", shutdownEffect(0, "sigint")).catch((error) => {
    logWorkerEdgeFailure("signal.sigint", error);
  });
});

process.on("uncaughtException", (error) => {
  handleFatalProcessError("uncaught_exception", "worker uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  handleFatalProcessError("unhandled_rejection", "worker unhandled rejection", reason);
});
