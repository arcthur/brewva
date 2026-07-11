import {
  BrewvaWorkerScope,
  runEdgeOperation,
  startBoundaryInterval,
  type BoundaryIntervalHandle,
} from "@brewva/brewva-effect";
import { BrewvaEffect, BrewvaStream } from "@brewva/brewva-effect/primitives";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context as ProviderContext,
  Model as ProviderModel,
  ProviderAssistantMessageStream,
  SimpleStreamOptions as ProviderSimpleStreamOptions,
  StreamOptions as ProviderStreamOptions,
  Usage as ProviderUsage,
} from "@brewva/brewva-provider-core/contracts";
import {
  registerExternalApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type {
  BrewvaMutableModelCatalog,
  BrewvaProviderModelDefinition,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { ContextStatusView } from "@brewva/brewva-vocabulary/context";
import type { ScheduleApprovalMode } from "@brewva/brewva-vocabulary/schedule";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { resumeDelegatedApprovalsWithinEnvelope } from "../../../delegation/api.js";
import { recordSessionShutdownIfMissing } from "../../../utils/runtime.js";
import {
  createHostedSession as createGatewaySession,
  type HostedSessionResult as GatewaySessionResult,
} from "../../internal/session/init/session-assembly.js";
import {
  getRuntimeContextStatus,
  getRuntimeContextUsage,
  getRuntimeLifecycleSnapshot,
  setRuntimeTaskSpec,
  subscribeRuntimeSessionWire,
} from "../../internal/session/runtime-ports.js";
import { TaskProgressWatchdog } from "../../internal/session/watchdog/task-progress-watchdog.js";
import type { HostedSessionLogger } from "../../internal/shared/logger.js";
import { runHostedTurnEnvelope } from "../../internal/turn/turn-envelope.js";
import { resolveWorkerSessionShutdownReceipt } from "../shutdown-receipts.js";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "./protocol.js";
import { createSessionWireRelayGate } from "./relay-gate.js";
import { buildTerminalTurnFailedFrame } from "./terminal-frame.js";
import { resolveWorkerTestHarness, type ResolvedWorkerTestHarness } from "./test-harness.js";

const BRIDGE_TIMEOUT_MS = 15_000;
const BRIDGE_HEARTBEAT_INTERVAL_MS = 4_000;

let requestedSessionId = "";
let expectedParentPid = 0;
let initialized = false;
let sessionResult: GatewaySessionResult | null = null;
let lastPingAt = Date.now();
let watchdog: BoundaryIntervalHandle | null = null;
let heartbeatTicker: BoundaryIntervalHandle | null = null;
let taskProgressWatchdog: TaskProgressWatchdog | null = null;
let shuttingDown = false;
let activeTurnId: string | null = null;
let pendingUserCancellationTurnId: string | null = null;
let unsubscribeSessionWire: (() => void) | null = null;
const sessionWireRelayGate = createSessionWireRelayGate();
let workerTestHarness: ResolvedWorkerTestHarness = {
  enabled: false,
  watchdog: {},
};
let workerFakeProviderCounter = 0;
let releaseWorkerTestHarnessRuntimeProvider: (() => void) | null = null;
type WorkerLogLevel = Extract<WorkerToParentMessage, { kind: "log" }>["level"];

const WORKER_FAKE_PROVIDER_USAGE: ProviderUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const hostedSessionLogger: HostedSessionLogger = {
  warn(message, fields) {
    log("warn", message, fields);
  },
};

type RuntimeTurnHarnessSession = GatewaySessionResult["session"] & {
  getModelCatalogForWorkerHarness(): BrewvaMutableModelCatalog;
  setModel(model: BrewvaRegisteredModel): Promise<void>;
};

function isRuntimeTurnHarnessSession(
  session: GatewaySessionResult["session"],
): session is RuntimeTurnHarnessSession {
  const candidate = session as Partial<RuntimeTurnHarnessSession>;
  return (
    typeof candidate.getModelCatalogForWorkerHarness === "function" &&
    typeof candidate.setModel === "function"
  );
}

function createWorkerFauxModelDefinition(api: string): BrewvaProviderModelDefinition {
  return {
    id: "faux-worker-1",
    name: "Faux Worker",
    api,
    baseUrl: "https://faux.invalid",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function createWorkerFakeAssistantMessage(input: {
  api: Api;
  provider: string;
  modelId: string;
  text: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: input.text }],
    api: input.api,
    provider: input.provider,
    model: input.modelId,
    usage: WORKER_FAKE_PROVIDER_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createWorkerFakeProviderStream(
  assistantText: string,
): (
  model: ProviderModel<Api>,
  context: ProviderContext,
  options?: ProviderStreamOptions,
) => ProviderAssistantMessageStream {
  return (model) => {
    const message = createWorkerFakeAssistantMessage({
      api: model.api,
      provider: model.provider,
      modelId: model.id,
      text: assistantText,
    });
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message,
    };
    return BrewvaStream.make(event);
  };
}

async function installWorkerFakeAssistantProvider(input: {
  result: GatewaySessionResult;
  assistantText: string;
}): Promise<void> {
  if (!isRuntimeTurnHarnessSession(input.result.session)) {
    throw new Error("worker_fake_provider_session_incompatible");
  }

  releaseWorkerTestHarnessRuntimeProvider?.();
  releaseWorkerTestHarnessRuntimeProvider = null;

  const suffix = `${process.pid || 0}-${++workerFakeProviderCounter}`;
  const providerName = `faux-worker-${suffix}`;
  const api = `faux-worker-api-${suffix}`;
  const sourceId = `worker-fake-provider-${suffix}`;
  const modelDefinition = createWorkerFauxModelDefinition(api);
  const stream = createWorkerFakeProviderStream(input.assistantText);
  registerExternalApiProvider(
    {
      api,
      stream,
      streamSimple(
        model: ProviderModel<Api>,
        context: ProviderContext,
        options?: ProviderSimpleStreamOptions,
      ) {
        return stream(model, context, options);
      },
    },
    sourceId,
  );

  const catalog = input.result.session.getModelCatalogForWorkerHarness();
  catalog.registerProvider(providerName, {
    apiKey: "test",
    models: [modelDefinition],
  });
  const selectedModel = catalog.find(providerName, modelDefinition.id);
  if (!selectedModel) {
    catalog.unregisterProvider(providerName);
    unregisterApiProviders(sourceId);
    throw new Error("worker_fake_provider_model_missing");
  }

  try {
    await input.result.session.setModel(selectedModel);
  } catch (error) {
    catalog.unregisterProvider(providerName);
    unregisterApiProviders(sourceId);
    throw error;
  }

  releaseWorkerTestHarnessRuntimeProvider = () => {
    catalog.unregisterProvider(providerName);
    unregisterApiProviders(sourceId);
  };
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

function sendTerminalTurnFailedFrame(
  sessionId: string,
  turnId: string,
  failureReason: string,
  attemptId: string,
): void {
  sendSessionWireFrame(
    sessionId,
    buildTerminalTurnFailedFrame({ sessionId, turnId, failureReason, attemptId }),
  );
}

function projectSessionContextStatus(sessionId: string): ContextStatusView | undefined {
  if (!sessionResult) {
    return undefined;
  }
  const usage = getRuntimeContextUsage(sessionResult.runtime, sessionId);
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
  const contextStatus = getRuntimeContextStatus(sessionResult.runtime, sessionId, usage);
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
    await taskProgressWatchdog?.stop();
    taskProgressWatchdog = null;
    releaseWorkerTestHarnessRuntimeProvider?.();
    releaseWorkerTestHarnessRuntimeProvider = null;
    try {
      await sessionResult.session.abort();
    } catch (abortError) {
      void abortError;
    }
    try {
      sessionResult.session.dispose();
    } catch {
      return;
    }
    sessionResult = null;
  }

  log("info", "worker exiting", { reason, exitCode, requestedSessionId });
  process.exit(exitCode);
}

function startBridgeWatchdog(): void {
  if (watchdog) return;

  watchdog = startBoundaryInterval({
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

  heartbeatTicker = startBoundaryInterval({
    intervalMs: BRIDGE_HEARTBEAT_INTERVAL_MS,
    run: () =>
      BrewvaEffect.sync(() => {
        send({ kind: "bridge.heartbeat", ts: Date.now() });
      }),
  });
}

async function stopBridgeWatchdog(): Promise<void> {
  const handles = [watchdog, heartbeatTicker].filter(
    (handle): handle is BoundaryIntervalHandle => handle !== null,
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
    if (workerTestHarness.fakeAssistantText) {
      await installWorkerFakeAssistantProvider({
        result: sessionResult,
        assistantText: workerTestHarness.fakeAssistantText,
      });
    }
    const agentSessionId = sessionResult.session.sessionManager.getSessionId();
    const watchdogOverrides = workerTestHarness.watchdog;
    if (watchdogOverrides.taskGoal) {
      setRuntimeTaskSpec(sessionResult.runtime, agentSessionId, {
        spec: {
          schema: "brewva.task.v1",
          goal: watchdogOverrides.taskGoal,
        },
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
    unsubscribeSessionWire = subscribeRuntimeSessionWire(
      sessionResult.runtime,
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
      error: toErrorMessage(error),
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
    approvalMode: message.payload.approvalMode,
  });
}

async function runTurn(input: {
  turnId: string;
  prompt: string;
  agentSessionId: string;
  walReplayId?: string;
  trigger?: Extract<ParentToWorkerMessage, { kind: "send" }>["payload"]["trigger"];
  source?: "gateway" | "heartbeat" | "schedule";
  approvalMode?: ScheduleApprovalMode;
}): Promise<void> {
  if (!sessionResult) {
    activeTurnId = null;
    return;
  }
  const workerSession = sessionResult.session;
  const workerRuntime = sessionResult.runtime;
  const releaseSessionWireRelay = sessionWireRelayGate.pause();
  try {
    const output = await runHostedTurnEnvelope({
      session: workerSession,
      runtime: workerRuntime,
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
    });
    // The config-authored self-improve schedule runs unattended: like a
    // delegated child, its effect boundary is already governed, so within the
    // human-declared envelope an approval suspension auto-resolves and the run
    // resumes. Each decision is recorded (actor = the schedule envelope) so the
    // auto-approval stays auditable. The daemon only ever sets this mode for
    // the config-identity intent — model-minted intents cannot reach it.
    if (input.source === "schedule" && input.approvalMode === "auto_within_envelope") {
      const resumeOutput = await resumeDelegatedApprovalsWithinEnvelope({
        initial: output,
        sessionId: input.agentSessionId,
        listPendingApprovals: (sessionId) =>
          workerRuntime.ops.proposals.requests.listPending(sessionId),
        acceptApproval: (sessionId, requestId) =>
          workerRuntime.ops.proposals.requests.decide(sessionId, requestId, {
            decision: "accept",
            actor: "schedule-envelope",
            reason:
              "config-authored self-improve schedule auto-approves effectful tools within its governed envelope",
          }),
        resumeTurn: (resolveApproval) =>
          runHostedTurnEnvelope({
            session: workerSession,
            runtime: workerRuntime,
            sessionId: input.agentSessionId,
            prompt: "",
            // Reuse the original turnId: the supervisor resolves the parent's
            // pending sendPrompt on the `turn.committed` frame KEYED BY turnId,
            // so a resume that minted a fresh id would complete invisibly and
            // leave the schedule runner waiting forever.
            turnId: input.turnId,
            source: "schedule",
            resolveApproval,
            onFrame: (frame) => {
              sendSessionWireFrame(requestedSessionId, frame);
            },
          }),
      });
      // The envelope converges to a terminal `runHostedTurnEnvelope` result on
      // its happy path, which already emitted a `turn.committed` frame. But it
      // can also give up while still suspended — the resume cap tripped, or a
      // suspension reported no pending approval to accept — and then NO terminal
      // frame was ever projected. Synthesize one so the supervisor's pending
      // send resolves instead of hanging until its timeout.
      if (resumeOutput.status !== "completed" && resumeOutput.status !== "failed") {
        log("warn", "schedule approval envelope did not converge", {
          agentSessionId: input.agentSessionId,
          turnId: input.turnId,
          status: resumeOutput.status,
        });
        sendTerminalTurnFailedFrame(
          requestedSessionId,
          input.turnId,
          `schedule_envelope_${resumeOutput.status}`,
          // A non-terminal (suspended) result carries no attemptId; match the
          // fallback runHostedTurnEnvelope uses for its own failure receipts.
          "runtime-turn",
        );
      }
    }
  } catch (error) {
    log("error", "worker turn envelope failed", {
      requestedSessionId,
      agentSessionId: input.agentSessionId,
      turnId: input.turnId,
      error: toErrorMessage(error),
    });
    // A throw inside the schedule approval envelope (a decide() or resume error)
    // must not vanish into a log line: the runtime never reached `turn.ended`, so
    // without a terminal frame the schedule runner waits out its timeout. Emit
    // the failure the supervisor resolves on. (Non-schedule turns terminate
    // through `runHostedTurnEnvelope`'s own internal failure receipt.)
    if (input.source === "schedule" && input.approvalMode === "auto_within_envelope") {
      sendTerminalTurnFailedFrame(
        requestedSessionId,
        input.turnId,
        "schedule_envelope_error",
        "runtime-turn",
      );
    }
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
    const shouldRememberUserSubmitInterrupt =
      message.payload?.reason === "user_submit" && activeTurnId !== null;
    if (shouldRememberUserSubmitInterrupt && activeTurnId) {
      pendingUserCancellationTurnId = activeTurnId;
    }
    await sessionResult.session.abort();
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
    send({
      kind: "result",
      requestId: message.requestId,
      ok: false,
      error: toErrorMessage(error),
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
      error: toErrorMessage(error),
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
      lifecycle: getRuntimeLifecycleSnapshot(sessionResult.runtime, agentSessionId),
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
    error: toErrorMessage(error),
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
    error: toErrorMessage(reason),
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
