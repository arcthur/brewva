import {
  type ContextPressureView,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  type SessionWireFrame,
  type TurnInputRecordedPayload,
  type TurnRenderCommittedPayload,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent, resolveRuntimeEventLogPath } from "@brewva/brewva-runtime/internal";
import { createRuntimeTurnClockStore } from "../runtime-plugins/runtime-turn-clock.js";
import { recordAbnormalSessionShutdown } from "../utils/runtime.js";
import { SessionPromptCollectionError, collectSessionPromptOutput } from "./collect-output.js";
import { createGatewaySession, type GatewaySessionResult } from "./create-session.js";
import { applySchedulePromptTrigger } from "./schedule-trigger.js";
import { TaskProgressWatchdog } from "./task-progress-watchdog.js";
import { recordSessionTurnTransition } from "./turn-transition.js";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "./worker-protocol.js";
import { resolveWorkerTestHarness, type ResolvedWorkerTestHarness } from "./worker-test-harness.js";

const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 4_000;

let requestedSessionId = "";
let expectedParentPid = 0;
let initialized = false;
let sessionResult: GatewaySessionResult | null = null;
let lastPingAt = Date.now();
let watchdog: ReturnType<typeof setInterval> | null = null;
let heartbeatTicker: ReturnType<typeof setInterval> | null = null;
let taskProgressWatchdog: TaskProgressWatchdog | null = null;
let shuttingDown = false;
let activeTurnId: string | null = null;
let pendingUserCancellationTurnId: string | null = null;
let unsubscribeSessionWire: (() => void) | null = null;
const workerTurnClock = createRuntimeTurnClockStore();
let workerTestHarness: ResolvedWorkerTestHarness = {
  enabled: false,
  watchdog: {},
};
type WorkerLogLevel = Extract<WorkerToParentMessage, { kind: "log" }>["level"];

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
    recordRuntimeEvent(runtime, {
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
    recordRuntimeEvent(runtime, {
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
  recordRuntimeEvent(runtime, {
    sessionId: agentSessionId,
    type: "turn_start",
    turn: runtimeTurn,
    payload: {
      localTurn,
      timestamp,
    },
  });
  recordRuntimeEvent(runtime, {
    sessionId: agentSessionId,
    type: "message_start",
    payload: message,
  });
  recordRuntimeEvent(runtime, {
    sessionId: agentSessionId,
    type: "message_end",
    payload: message,
  });
  runtime.maintain.context.onTurnEnd(agentSessionId);
  recordRuntimeEvent(runtime, {
    sessionId: agentSessionId,
    type: "turn_end",
    turn: runtimeTurn,
    payload: {
      localTurn,
      message,
      toolResults: 0,
    },
  });
  recordRuntimeEvent(runtime, {
    sessionId: agentSessionId,
    type: "agent_end",
    payload: {
      messageCount: 1,
      costSummary: runtime.inspect.cost.getSummary(agentSessionId),
    },
  });
}

function resolveNextRuntimeTurn(agentSessionId: string): number {
  if (!sessionResult) {
    return 0;
  }
  return sessionResult.runtime.inspect.events.query(agentSessionId, {
    type: "turn_start",
  }).length;
}

function resolveTurnTrigger(input: {
  source?: "gateway" | "heartbeat" | "schedule";
  walReplayId?: string;
}): TurnInputRecordedPayload["trigger"] {
  if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
    return "recovery";
  }
  if (input.source === "heartbeat") {
    return "heartbeat";
  }
  if (input.source === "schedule") {
    return "schedule";
  }
  return "user";
}

function recordTurnInputReceipt(input: {
  agentSessionId: string;
  turnId: string;
  prompt: string;
  runtimeTurn: number;
  source?: "gateway" | "heartbeat" | "schedule";
  walReplayId?: string;
}): void {
  if (!sessionResult) {
    return;
  }
  const payload: TurnInputRecordedPayload = {
    turnId: input.turnId,
    trigger: resolveTurnTrigger({
      source: input.source,
      walReplayId: input.walReplayId,
    }),
    promptText: input.prompt,
  };
  recordRuntimeEvent(sessionResult.runtime, {
    sessionId: input.agentSessionId,
    turn: input.runtimeTurn,
    type: TURN_INPUT_RECORDED_EVENT_TYPE,
    payload,
  });
}

function recordTurnCommittedReceipt(input: {
  agentSessionId: string;
  turnId: string;
  runtimeTurn: number;
  attemptId: string;
  status: TurnRenderCommittedPayload["status"];
  assistantText: string;
  toolOutputs: TurnRenderCommittedPayload["toolOutputs"];
}): void {
  if (!sessionResult) {
    return;
  }
  const payload: TurnRenderCommittedPayload = {
    turnId: input.turnId,
    attemptId: input.attemptId,
    status: input.status,
    assistantText: input.assistantText,
    toolOutputs: input.toolOutputs,
  };
  recordRuntimeEvent(sessionResult.runtime, {
    sessionId: input.agentSessionId,
    turn: input.runtimeTurn,
    type: TURN_RENDER_COMMITTED_EVENT_TYPE,
    payload,
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

function projectSessionContextPressure(sessionId: string): ContextPressureView | undefined {
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
  const limit = Math.max(0, usage.contextWindow);
  if (limit <= 0) {
    return undefined;
  }
  const pressure = sessionResult.runtime.inspect.context.getPressureStatus(sessionId, usage);
  const level =
    pressure.level === "high"
      ? "elevated"
      : pressure.level === "critical"
        ? "critical"
        : pressure.level === "none" || pressure.level === "low" || pressure.level === "medium"
          ? "normal"
          : undefined;
  if (!level) {
    return undefined;
  }
  return {
    tokens: Math.max(0, usage.tokens),
    limit,
    level,
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

function shouldRecordAbnormalShutdown(reason: string): boolean {
  return (
    reason === "init_failed" ||
    reason === "parent_disconnected" ||
    reason === "parent_pid_mismatch" ||
    reason === "uncaught_exception" ||
    reason === "unhandled_rejection"
  );
}

async function shutdown(exitCode = 0, reason = "shutdown", shutdownError?: unknown): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (heartbeatTicker) {
    clearInterval(heartbeatTicker);
    heartbeatTicker = null;
  }

  if (sessionResult) {
    const runtime = sessionResult.runtime;
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    unsubscribeSessionWire?.();
    unsubscribeSessionWire = null;
    if (shouldRecordAbnormalShutdown(reason)) {
      recordAbnormalSessionShutdown(runtime, {
        sessionId: agentSessionId,
        source: reason,
        error: shutdownError,
      });
    }
    const interruptReason =
      reason === "bridge_timeout"
        ? ("timeout_interrupt" as const)
        : reason === "sigterm" || reason === "sigint"
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
        error: reason,
      });
    } else if (interruptReason === "signal_interrupt") {
      recordSessionTurnTransition(runtime, {
        sessionId: agentSessionId,
        reason: interruptReason,
        status: "entered",
        family: "interrupt",
        error: reason,
      });
    }
    taskProgressWatchdog?.stop();
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
      // best effort
    }
    workerTurnClock.clearSession(agentSessionId);
    sessionResult = null;
  }

  log("info", "worker exiting", { reason, exitCode, requestedSessionId });
  process.exit(exitCode);
}

function startBridgeWatchdog(): void {
  if (watchdog) return;

  watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastPingAt > BRIDGE_TIMEOUT_MS) {
      void shutdown(1, "bridge_timeout");
      return;
    }

    if (expectedParentPid > 0 && process.ppid !== expectedParentPid) {
      void shutdown(1, "parent_pid_mismatch");
      return;
    }
  }, 1000);
  watchdog.unref?.();

  heartbeatTicker = setInterval(() => {
    send({ kind: "bridge.heartbeat", ts: Date.now() });
  }, BRIDGE_HEARTBEAT_INTERVAL_MS);
  heartbeatTicker.unref?.();
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
    });
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    const agentEventLogPath = resolveRuntimeEventLogPath(sessionResult.runtime, agentSessionId);
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
  const runtimeTurn = resolveNextRuntimeTurn(input.agentSessionId);
  recordTurnInputReceipt({
    agentSessionId: input.agentSessionId,
    turnId: input.turnId,
    prompt: input.prompt,
    runtimeTurn,
    source: input.source,
    walReplayId: input.walReplayId,
  });

  try {
    if (input.trigger?.kind === "schedule") {
      applySchedulePromptTrigger(sessionResult.runtime, input.agentSessionId, input.trigger);
    }
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
        turn: runtimeTurn,
        reason: "wal_recovery_resume",
        status: "entered",
        family: "recovery",
        sourceEventId: input.walReplayId,
        sourceEventType: "recovery_wal_recovery_completed",
      });
    }
    const fakeAssistantText = workerTestHarness.fakeAssistantText;
    if (fakeAssistantText) {
      recordFakeTurnLifecycle(input.agentSessionId, input.turnId, fakeAssistantText);
      if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
        recordSessionTurnTransition(sessionResult.runtime, {
          sessionId: input.agentSessionId,
          turn: runtimeTurn,
          reason: "wal_recovery_resume",
          status: "completed",
          family: "recovery",
          sourceEventId: input.walReplayId,
          sourceEventType: "recovery_wal_recovery_completed",
        });
      }
      recordTurnCommittedReceipt({
        agentSessionId: input.agentSessionId,
        turnId: input.turnId,
        runtimeTurn,
        attemptId: "attempt-1",
        status: "completed",
        assistantText: fakeAssistantText,
        toolOutputs: [],
      });
      return;
    }
    const output = await collectSessionPromptOutput(sessionResult.session, input.prompt, {
      runtime: sessionResult.runtime,
      sessionId: input.agentSessionId,
      turnId: input.turnId,
      onFrame: (frame) => {
        sendSessionWireFrame(requestedSessionId, frame);
      },
    });
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
        turn: runtimeTurn,
        reason: "wal_recovery_resume",
        status: "completed",
        family: "recovery",
        sourceEventId: input.walReplayId,
        sourceEventType: "recovery_wal_recovery_completed",
      });
    }

    recordTurnCommittedReceipt({
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      runtimeTurn,
      attemptId: output.attemptId,
      status: "completed",
      assistantText: output.assistantText,
      toolOutputs: output.toolOutputs,
    });
  } catch (error) {
    const isCancelled = pendingUserCancellationTurnId === input.turnId;
    const collectionError =
      error instanceof SessionPromptCollectionError
        ? error
        : new SessionPromptCollectionError(error instanceof Error ? error.message : String(error), {
            attemptId: "attempt-1",
            assistantText: "",
            toolOutputs: [],
          });
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
        turn: runtimeTurn,
        reason: "wal_recovery_resume",
        status: "failed",
        family: "recovery",
        sourceEventId: input.walReplayId,
        sourceEventType: "recovery_wal_recovery_completed",
        error: collectionError.message,
      });
    }
    recordTurnCommittedReceipt({
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      runtimeTurn,
      attemptId: collectionError.attemptId,
      status: isCancelled ? "cancelled" : "failed",
      assistantText: collectionError.assistantText,
      toolOutputs: collectionError.toolOutputs,
    });
  } finally {
    if (pendingUserCancellationTurnId === input.turnId) {
      pendingUserCancellationTurnId = null;
    }
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

async function handleSessionContextPressureQuery(
  message: Extract<ParentToWorkerMessage, { kind: "sessionContextPressure.query" }>,
): Promise<void> {
  if (!sessionResult) {
    send({
      kind: "result",
      requestId: message.requestId,
      ok: true,
      payload: {
        contextPressure: undefined,
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
      contextPressure: projectSessionContextPressure(agentSessionId),
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

  if (kind === "sessionContextPressure.query") {
    await handleSessionContextPressureQuery(
      raw as Extract<ParentToWorkerMessage, { kind: "sessionContextPressure.query" }>,
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

process.on("message", (message) => {
  void handleMessage(message);
});

process.on("disconnect", () => {
  void shutdown(0, "parent_disconnected");
});

process.on("SIGTERM", () => {
  void shutdown(0, "sigterm");
});

process.on("SIGINT", () => {
  void shutdown(0, "sigint");
});

process.on("uncaughtException", (error) => {
  log("error", "worker uncaught exception", {
    requestedSessionId,
    error: error instanceof Error ? error.message : String(error),
  });
  void shutdown(1, "uncaught_exception", error);
});

process.on("unhandledRejection", (reason) => {
  log("error", "worker unhandled rejection", {
    requestedSessionId,
    error: reason instanceof Error ? reason.message : String(reason),
  });
  void shutdown(1, "unhandled_rejection", reason);
});
