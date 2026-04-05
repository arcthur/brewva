import { recordRuntimeEvent, resolveRuntimeEventLogPath } from "@brewva/brewva-runtime/internal";
import { createRuntimeTurnClockStore } from "../runtime-plugins/runtime-turn-clock.js";
import { recordAbnormalSessionShutdown } from "../utils/runtime.js";
import { collectSessionPromptOutput } from "./collect-output.js";
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

function send(message: WorkerToParentMessage): void {
  if (typeof process.send !== "function") {
    return;
  }
  process.send(message);
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
  });
}

async function runTurn(input: {
  turnId: string;
  prompt: string;
  agentSessionId: string;
  walReplayId?: string;
  trigger?: Extract<ParentToWorkerMessage, { kind: "send" }>["payload"]["trigger"];
}): Promise<void> {
  if (!sessionResult) {
    activeTurnId = null;
    return;
  }

  send({
    kind: "event",
    event: "session.turn.start",
    payload: {
      sessionId: requestedSessionId,
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      ts: Date.now(),
    },
  });

  try {
    if (input.trigger?.kind === "schedule") {
      applySchedulePromptTrigger(sessionResult.runtime, input.agentSessionId, input.trigger);
    }
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
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
          reason: "wal_recovery_resume",
          status: "completed",
          family: "recovery",
          sourceEventId: input.walReplayId,
          sourceEventType: "recovery_wal_recovery_completed",
        });
      }
      send({
        kind: "event",
        event: "session.turn.end",
        payload: {
          sessionId: requestedSessionId,
          agentSessionId: input.agentSessionId,
          turnId: input.turnId,
          attemptId: "attempt-1",
          assistantText: fakeAssistantText,
          toolOutputs: [],
          ts: Date.now(),
        },
      });
      return;
    }
    const output = await collectSessionPromptOutput(sessionResult.session, input.prompt, {
      runtime: sessionResult.runtime,
      sessionId: input.agentSessionId,
      onChunk: (chunk) => {
        send({
          kind: "event",
          event: "session.turn.chunk",
          payload: {
            sessionId: requestedSessionId,
            agentSessionId: input.agentSessionId,
            turnId: input.turnId,
            chunk,
            ts: Date.now(),
          },
        });
      },
    });
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
        reason: "wal_recovery_resume",
        status: "completed",
        family: "recovery",
        sourceEventId: input.walReplayId,
        sourceEventType: "recovery_wal_recovery_completed",
      });
    }

    send({
      kind: "event",
      event: "session.turn.end",
      payload: {
        sessionId: requestedSessionId,
        agentSessionId: input.agentSessionId,
        turnId: input.turnId,
        attemptId: output.attemptId,
        assistantText: output.assistantText,
        toolOutputs: output.toolOutputs,
        ts: Date.now(),
      },
    });
  } catch (error) {
    if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
      recordSessionTurnTransition(sessionResult.runtime, {
        sessionId: input.agentSessionId,
        reason: "wal_recovery_resume",
        status: "failed",
        family: "recovery",
        sourceEventId: input.walReplayId,
        sourceEventType: "recovery_wal_recovery_completed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    send({
      kind: "event",
      event: "session.turn.error",
      payload: {
        sessionId: requestedSessionId,
        agentSessionId: input.agentSessionId,
        turnId: input.turnId,
        message: error instanceof Error ? error.message : String(error),
        ts: Date.now(),
      },
    });
  } finally {
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
