import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { BrewvaEffect, startScopedTimeout, type ScopedTimeoutHandle } from "@brewva/brewva-effect";
import {
  recordAbnormalSessionShutdown,
  recordSessionShutdownIfMissing,
  recordSessionTurnTransition,
} from "@brewva/brewva-gateway";
import { runGatewayCliOperation } from "@brewva/brewva-gateway/admin";
import { runChannelMode } from "@brewva/brewva-gateway/channels";
import { createBrewvaRuntime, selectOperatorRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type { RuntimeResult } from "@brewva/brewva-runtime/core";
import { createTrustedLocalGovernancePort } from "@brewva/brewva-runtime/governance";
import { parseTaskSpec } from "@brewva/brewva-runtime/task";
import type { TaskSpec } from "@brewva/brewva-runtime/task";
import { formatISO } from "date-fns";
import { handleInsightsChannelCommand } from "../commands/channel-handlers/insights.js";
import { handleInspectChannelCommand } from "../commands/channel-handlers/inspect.js";
import { handleQuestionsChannelCommand } from "../commands/channel-handlers/questions.js";
import { runDaemon } from "../commands/noninteractive/daemon.js";
import { runOnboardCliOperation } from "../commands/noninteractive/onboard.js";
import { createAgentOverlaysCommandExtension } from "../commands/shell-extensions/agent-overlays.js";
import { createInsightsCommandExtension } from "../commands/shell-extensions/insights.js";
import { createInspectCommandExtension } from "../commands/shell-extensions/inspect.js";
import { createQuestionsCommandExtension } from "../commands/shell-extensions/questions.js";
import { createUpdateCommandExtension } from "../commands/shell-extensions/update.js";
import { runCredentialsCli } from "../io/credentials.js";
import {
  resolveBackendWorkingCwd,
  shouldFallbackAfterGatewayFailure,
  tryGatewayPrint,
  writeGatewayAssistantText,
} from "../io/gateway-print.js";
import { writeJsonLine } from "../io/json-lines.js";
import { runSkillsMigrateCli } from "../io/skills-migrate.js";
import { resolveTargetSession, runInspectCli } from "../operator/inspect.js";
import type { CliInteractiveSessionOptions } from "../session/cli-runtime.js";
import { runCliPrintSession } from "../session/cli-runtime.js";
import { createBrewvaSession } from "../session/session.js";
import {
  parseArgs,
  parseCliArgs,
  resolveRootSubcommand,
  type CliArgs,
  type CliMode,
} from "./args.js";
import { printHelp } from "./help.js";
import { resolveEffectiveCliMode } from "./mode.js";
export { parseArgs } from "./args.js";
export { assertSupportedRuntime, printStartupError } from "./runtime-guard.js";

const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";
const BREWVA_OPENTUI_UNSUPPORTED_MESSAGE =
  "Interactive shell is not available on this Brewva build target yet. Use --print/--mode json or a promoted glibc/macOS build.";

type CliInteractiveShellRuntimeModule = typeof import("@brewva/brewva-cli/internal-shell-runtime");

type CliValueResult<T> = RuntimeResult<{ value: T }>;

function okCliValue<T>(value: T): CliValueResult<T> {
  return { ok: true, value };
}

async function runInsightsCli(argv: string[]): Promise<number> {
  const { runInsightsCli: loadedRunInsightsCli } = await import("../operator/insights.js");
  return loadedRunInsightsCli(argv);
}

function cliValueError(error: string): CliValueResult<never> {
  return { ok: false, reason: error };
}

function resolveSessionRewindSession(
  runtime: BrewvaRuntimeRoot,
  operation: "undo" | "redo",
  preferredSessionId?: string,
): string | undefined {
  if (preferredSessionId) {
    const state = runtime.inspect.session.rewind.getState(preferredSessionId);
    if (state.checkpoints.length > 0 || state.rewindAvailable || state.redoAvailable) {
      return preferredSessionId;
    }
    return undefined;
  }
  let selected: { sessionId: string; timestamp: number } | undefined;
  for (const sessionId of runtime.inspect.events.log.listSessionIds()) {
    const state = runtime.inspect.session.rewind.getState(sessionId);
    const candidate = operation === "redo" ? state.nextRedoable : state.latestRewindable;
    if (!candidate) {
      continue;
    }
    const timestamp =
      operation === "redo" ? (candidate.undoneAt ?? candidate.timestamp) : candidate.timestamp;
    if (!selected || timestamp > selected.timestamp) {
      selected = { sessionId, timestamp };
    }
  }
  return selected?.sessionId;
}

const CLI_TRUSTED_LOCAL_GOVERNANCE = { profile: "personal" } as const;

const loadCliInteractiveRuntime: () => Promise<CliInteractiveShellRuntimeModule> =
  process.env.BREWVA_OPENTUI_SUPPORTED === "0"
    ? async () => {
        throw new Error(BREWVA_OPENTUI_UNSUPPORTED_MESSAGE);
      }
    : async () => await import("@brewva/brewva-cli/internal-shell-runtime");

function loadTaskSpec(parsed: CliArgs): CliValueResult<TaskSpec | undefined> {
  if (!parsed.taskJson && !parsed.taskFile) {
    return okCliValue(undefined);
  }
  if (parsed.taskJson && parsed.taskFile) {
    return cliValueError("Error: use only one of --task or --task-file.");
  }

  let raw = "";
  if (parsed.taskJson) {
    raw = parsed.taskJson;
  } else if (parsed.taskFile) {
    const absolute = resolve(parsed.taskFile);
    try {
      raw = readFileSync(absolute, "utf8");
    } catch (error) {
      return cliValueError(
        `Error: failed to read TaskSpec file (${absolute}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return cliValueError(
      `Error: failed to parse TaskSpec JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const result = parseTaskSpec(value);
  if (!result.ok) {
    return cliValueError(`Error: invalid TaskSpec: ${result.reason}`);
  }
  return okCliValue(result.spec);
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  return await new Promise((fulfill) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      const text = data.trim();
      fulfill(text.length > 0 ? text : undefined);
    });
    process.stdin.resume();
  });
}

function printReplayText(
  events: Array<{
    timestamp: number;
    turn?: number;
    type: string;
    payload?: Record<string, unknown>;
  }>,
): void {
  for (const event of events) {
    const iso = formatISO(event.timestamp);
    const turnText = typeof event.turn === "number" ? `turn=${event.turn}` : "turn=-";
    const payload = event.payload ? JSON.stringify(event.payload) : "{}";
    console.log(`${iso} ${turnText} ${event.type} ${payload}`);
  }
}

function printCostSummary(sessionId: string, runtime: BrewvaRuntimeRoot): void {
  const summary = runtime.inspect.cost.summary.get(sessionId);
  if (summary.totalTokens <= 0 && summary.totalCostUsd <= 0) return;

  const topSkill = Object.entries(summary.skills).toSorted(
    (a, b) => b[1].totalCostUsd - a[1].totalCostUsd,
  )[0];
  const topTool = Object.entries(summary.tools).toSorted(
    (a, b) => b[1].allocatedCostUsd - a[1].allocatedCostUsd,
  )[0];

  const parts = [
    `tokens=${summary.totalTokens}`,
    `cost=$${summary.totalCostUsd.toFixed(6)}`,
    `budget=${summary.budget.blocked ? "blocked" : "ok"}`,
  ];
  if (topSkill) {
    parts.push(`topSkill=${topSkill[0]}($${topSkill[1].totalCostUsd.toFixed(6)})`);
  }
  if (topTool) {
    parts.push(`topTool=${topTool[0]}($${topTool[1].allocatedCostUsd.toFixed(6)})`);
  }
  console.error(`[cost] session=${sessionId} ${parts.join(" ")}`);
}

function printGatewayCostSummary(input: {
  cwd?: string;
  configPath?: string;
  requestedSessionId: string;
  agentSessionId?: string;
}): void {
  const replaySessionId =
    typeof input.agentSessionId === "string" && input.agentSessionId.trim()
      ? input.agentSessionId
      : input.requestedSessionId;
  const runtime = createBrewvaRuntime({
    cwd: resolveBackendWorkingCwd(input.cwd),
    configPath: input.configPath,
    governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
  });
  selectOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(replaySessionId, 0);
  printCostSummary(replaySessionId, runtime.root);
}

function resolveCliSessionCompleteReason(runtime: BrewvaRuntimeRoot, sessionId: string): string {
  const events = runtime.inspect.events.records.queryStructured(sessionId);
  const hasInput = events.some((event) => event.type === "input");
  const hasAgentStart = events.some((event) => event.type === "agent_start");
  if (!hasInput && !hasAgentStart) {
    return "cli_session_no_input";
  }
  if (hasInput && !hasAgentStart) {
    return "cli_session_no_agent_run";
  }
  return "cli_session_complete";
}

export async function runCliRootOperation(): Promise<void> {
  process.title = "brewva";
  if (process.env[BREWVA_SHELL_SMOKE_ENV] === "1") {
    const { runCliInteractiveSmoke } = await loadCliInteractiveRuntime();
    await runCliInteractiveSmoke();
    return;
  }
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "insight") {
    console.error(
      "Error: unknown subcommand. Use 'brewva credentials', 'brewva inspect', 'brewva insights', 'brewva onboard', or 'brewva gateway'.",
    );
    process.exitCode = 1;
    return;
  }
  const subcommand = resolveRootSubcommand(rawArgs);
  if (subcommand?.name === "gateway") {
    const gatewayResult = await runGatewayCliOperation(subcommand.args);
    if (gatewayResult.handled) {
      process.exitCode = gatewayResult.exitCode;
      return;
    }
  }
  if (subcommand?.name === "credentials") {
    process.exitCode = await runCredentialsCli(subcommand.args);
    return;
  }
  if (subcommand?.name === "onboard") {
    process.exitCode = await runOnboardCliOperation(subcommand.args);
    return;
  }
  if (subcommand?.name === "inspect") {
    process.exitCode = await runInspectCli(subcommand.args);
    return;
  }
  if (subcommand?.name === "insights") {
    process.exitCode = await runInsightsCli(subcommand.args);
    return;
  }
  if (subcommand?.name === "skills") {
    process.exitCode = await runSkillsMigrateCli(subcommand.args);
    return;
  }

  const parseResult = parseCliArgs(rawArgs);
  if (parseResult.kind === "help" || parseResult.kind === "version") {
    return;
  }
  if (parseResult.kind === "error") {
    process.exitCode = 1;
    return;
  }
  const parsed = parseResult.args;

  if (parsed.channel) {
    if (parsed.backend === "gateway") {
      console.error("Error: --backend gateway is not supported with --channel.");
      process.exitCode = 1;
      return;
    }
    if (parsed.daemon) {
      console.error("Error: --channel cannot be combined with --daemon.");
      process.exitCode = 1;
      return;
    }
    if (parsed.undo || parsed.redo || parsed.replay) {
      console.error("Error: --channel cannot be combined with --undo/--redo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (parsed.taskJson || parsed.taskFile) {
      console.error("Error: --channel cannot be combined with --task/--task-file.");
      process.exitCode = 1;
      return;
    }
    if (parsed.prompt) {
      console.error("Error: --channel mode does not accept prompt text.");
      process.exitCode = 1;
      return;
    }
    if (parsed.modeExplicit && parsed.mode !== "interactive") {
      console.error("Error: --channel mode cannot be combined with --print/--json/--mode.");
      process.exitCode = 1;
      return;
    }
    await runChannelMode({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      managedToolMode: parsed.managedToolMode,
      verbose: parsed.verbose,
      channel: parsed.channel,
      channelConfig: parsed.channelConfig,
      dependencies: {
        handleInspectCommand: handleInspectChannelCommand,
        handleInsightsCommand: handleInsightsChannelCommand,
        handleQuestionsCommand: handleQuestionsChannelCommand,
      },
    });
    return;
  }

  if (parsed.daemon) {
    if (parsed.backend === "gateway") {
      console.error("Error: --backend gateway is not supported with --daemon.");
      process.exitCode = 1;
      return;
    }
    if (parsed.modeExplicit && parsed.mode !== "interactive") {
      console.error("Error: --daemon cannot be combined with --print/--json/--mode.");
      process.exitCode = 1;
      return;
    }
    if (parsed.undo || parsed.redo || parsed.replay) {
      console.error("Error: --daemon cannot be combined with --undo/--redo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (parsed.taskJson || parsed.taskFile) {
      console.error("Error: --daemon cannot be combined with --task/--task-file.");
      process.exitCode = 1;
      return;
    }
    if (parsed.prompt) {
      console.error("Error: --daemon does not accept prompt text.");
      process.exitCode = 1;
      return;
    }

    await runDaemon({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      managedToolMode: parsed.managedToolMode,
      verbose: parsed.verbose,
    });
    return;
  }

  if (parsed.replay) {
    const replayMode: CliMode = parsed.mode === "print-json" ? "print-json" : "print-text";
    const runtime = createBrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
    });
    const targetSessionId = resolveTargetSession(
      selectOperatorRuntimePort(runtime),
      parsed.sessionId,
    );
    if (!targetSessionId) {
      console.error("Error: no replayable session found.");
      process.exitCode = 1;
      return;
    }
    const events = runtime.root.inspect.events.records.queryStructured(targetSessionId);
    if (replayMode === "print-json") {
      for (const event of events) {
        await writeJsonLine(event);
      }
    } else {
      printReplayText(events);
    }
    return;
  }

  if (parsed.undo || parsed.redo) {
    const runtime = createBrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
    });
    const targetSessionId = resolveSessionRewindSession(
      runtime.root,
      parsed.redo ? "redo" : "undo",
      parsed.sessionId,
    );
    if (!targetSessionId) {
      console.log(`No session ${parsed.redo ? "redo" : "undo"} applied (no_checkpoint).`);
      return;
    }
    const result = parsed.redo
      ? runtime.root.authority.session.rewind.redo(targetSessionId)
      : runtime.root.authority.session.rewind.rewind(targetSessionId, {
          mode: "both",
          summary: "carry",
        });
    if (!result.ok) {
      console.log(`No session ${parsed.redo ? "redo" : "undo"} applied (${result.reason}).`);
    } else {
      const promptSuffix = result.restoredPrompt?.text
        ? ` Restored prompt: ${result.restoredPrompt.text.trim()}`
        : "";
      console.log(
        `Session ${parsed.redo ? "redo" : "undo"} applied in session ${targetSessionId} (${result.patchSetIds.length} patch set(s)).${promptSuffix}`,
      );
    }
    return;
  }

  const pipedInput = await readPipedStdin();
  const taskResolved = loadTaskSpec(parsed);
  if (!taskResolved.ok) {
    console.error(taskResolved.reason);
    process.exitCode = 1;
    return;
  }

  let taskSpec = taskResolved.value;
  let initialMessage = parsed.prompt ?? pipedInput;
  if (taskSpec && parsed.prompt) {
    taskSpec = { ...taskSpec, goal: parsed.prompt.trim() };
  }
  if (taskSpec && !initialMessage) {
    initialMessage = taskSpec.goal;
  }

  const modeResolution = resolveEffectiveCliMode({
    requestedMode: parsed.mode,
    modeExplicit: parsed.modeExplicit,
    initialMessage,
    capabilitiesInput: {
      env: process.env,
      stdin: {
        isTTY: process.stdin.isTTY,
      },
      stdout: {
        isTTY: process.stdout.isTTY,
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        getColorDepth:
          typeof process.stdout.getColorDepth === "function"
            ? () => process.stdout.getColorDepth()
            : undefined,
      },
    },
  });
  if ("error" in modeResolution) {
    console.error(modeResolution.error);
    process.exitCode = 1;
    return;
  }
  const mode = modeResolution.mode;

  if (mode !== "interactive" && !initialMessage) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (taskSpec && parsed.backend === "gateway") {
    console.error("Error: --task/--task-file is not supported with --backend gateway.");
    process.exitCode = 1;
    return;
  }

  if (parsed.backend === "gateway") {
    if (parsed.undo || parsed.redo || parsed.replay) {
      console.error("Error: --backend gateway is not supported with --undo/--redo/--replay.");
      process.exitCode = 1;
      return;
    }
    if (mode === "interactive") {
      console.error("Error: --backend gateway is not supported in interactive mode.");
      process.exitCode = 1;
      return;
    }
    if (mode === "print-json") {
      console.error("Error: --backend gateway is not supported with --mode json.");
      process.exitCode = 1;
      return;
    }
  }

  const shouldAttemptGatewayPrint =
    mode === "print-text" && parsed.backend !== "embedded" && !taskSpec;
  if (mode === "print-text" && parsed.backend === "auto" && taskSpec && parsed.verbose) {
    console.error("[backend] skipping gateway because TaskSpec requires embedded path");
  }

  if (shouldAttemptGatewayPrint) {
    const gatewayResult = await tryGatewayPrint({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      managedToolMode: parsed.managedToolMode,
      prompt: initialMessage ?? "",
      verbose: parsed.verbose,
    });
    if (gatewayResult.ok) {
      writeGatewayAssistantText(gatewayResult.assistantText);
      printGatewayCostSummary({
        cwd: parsed.cwd,
        configPath: parsed.configPath,
        requestedSessionId: gatewayResult.requestedSessionId,
        agentSessionId: gatewayResult.agentSessionId,
      });
      return;
    }

    if (parsed.backend === "gateway") {
      console.error(`gateway: ${gatewayResult.error}`);
      process.exitCode = 1;
      return;
    }

    if (shouldFallbackAfterGatewayFailure(parsed.backend, gatewayResult.stage)) {
      if (parsed.verbose) {
        console.error(
          `[backend] gateway unavailable (${gatewayResult.error}), falling back to embedded`,
        );
      }
    } else {
      console.error(`gateway: ${gatewayResult.error}`);
      process.exitCode = 1;
      return;
    }
  }

  const runtimeInstance = createBrewvaRuntime({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    agentId: parsed.agentId,
    governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
  });
  const runtime = runtimeInstance.hosted;
  const operatorRuntime = selectOperatorRuntimePort(runtimeInstance);
  const createExtensions = () => [
    createInspectCommandExtension(operatorRuntime),
    createInsightsCommandExtension(operatorRuntime),
    createQuestionsCommandExtension(runtime),
    createAgentOverlaysCommandExtension(runtime),
    createUpdateCommandExtension(runtime),
  ];
  const openEmbeddedSession = (sessionId?: string) =>
    createBrewvaSession({
      runtime,
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      model: parsed.model,
      agentId: parsed.agentId,
      managedToolMode: parsed.managedToolMode,
      sessionId,
      deferPersistenceUntilPrompt: mode === "interactive",
      extensions: createExtensions(),
    });
  let sessionResult = await openEmbeddedSession(parsed.sessionId);
  let session = sessionResult.session;
  let orchestration = sessionResult.orchestration;
  const printSession = session;

  const getSessionId = (): string => session.sessionManager.getSessionId();
  const sessionEventBaselineById = new Map<string, number>();
  const rememberSessionEventBaseline = (sessionId: string): void => {
    if (sessionEventBaselineById.has(sessionId)) {
      return;
    }
    sessionEventBaselineById.set(sessionId, runtime.inspect.events.records.list(sessionId).length);
  };
  const hasSessionPersistedActivity = (sessionId: string): boolean => {
    const baseline = sessionEventBaselineById.get(sessionId) ?? 0;
    return runtime.inspect.events.records.list(sessionId).length > baseline;
  };
  const ensureSessionInitialPersistence = async (): Promise<void> => {
    const ensureInitialPersistence = (session as { ensureInitialPersistence?: unknown })
      .ensureInitialPersistence;
    if (typeof ensureInitialPersistence !== "function") {
      return;
    }
    await ensureInitialPersistence.call(session);
  };
  const initialSessionId = getSessionId();
  rememberSessionEventBaseline(initialSessionId);
  if (taskSpec) {
    await ensureSessionInitialPersistence();
    runtime.authority.task.spec.set(initialSessionId, taskSpec);
  }
  const gracefulTimeoutMs = runtime.config.infrastructure.interruptRecovery.gracefulTimeoutMs;
  let terminatedBySignal = false;
  let finalized = false;
  let shutdownReceipt:
    | {
        reason: string;
        source: string;
      }
    | undefined;
  const finalizeAndExit = (code: number): void => {
    if (finalized) return;
    finalized = true;
    const sessionId = getSessionId();
    if (hasSessionPersistedActivity(sessionId)) {
      recordSessionShutdownIfMissing(runtime, {
        sessionId,
        reason: shutdownReceipt?.reason ?? "cli_session_terminated",
        source: shutdownReceipt?.source ?? "cli_embedded_session",
      });
    }
    session.dispose();
    process.exit(code);
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (terminatedBySignal) return;
    terminatedBySignal = true;
    shutdownReceipt = {
      reason: signal === "SIGINT" ? "sigint" : "sigterm",
      source: "cli_signal",
    };

    const sessionId = getSessionId();
    const shouldRecordSignalTransition = hasSessionPersistedActivity(sessionId);
    let signalTransitionFinalized = false;
    const finalizeSignalTransition = (status: "completed" | "failed", error?: string): void => {
      if (!shouldRecordSignalTransition) {
        return;
      }
      if (signalTransitionFinalized) {
        return;
      }
      signalTransitionFinalized = true;
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "signal_interrupt",
        status,
        family: "interrupt",
        error: error?.trim().length ? error : undefined,
      });
    };
    if (shouldRecordSignalTransition) {
      recordSessionTurnTransition(runtime, {
        sessionId,
        reason: "signal_interrupt",
        status: "entered",
        family: "interrupt",
        error: signal,
      });
    }

    const timeout: ScopedTimeoutHandle = startScopedTimeout({
      delayMs: gracefulTimeoutMs,
      run: () =>
        BrewvaEffect.promise(async () => {
          try {
            await session.abort();
            finalizeSignalTransition("completed");
          } catch (error) {
            finalizeSignalTransition(
              "failed",
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            finalizeAndExit(130);
          }
        }),
    });

    void session
      .waitForIdle()
      .catch(() => undefined)
      .finally(() => {
        void timeout.close();
        finalizeSignalTransition("completed");
        finalizeAndExit(130);
      });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  let emitJsonBundle = false;

  try {
    if (mode === "interactive") {
      const interactiveRuntime = await loadCliInteractiveRuntime();
      const interactiveOptions: CliInteractiveSessionOptions = {
        runtime,
        providerConnections: sessionResult.providerConnections,
        initPhases: sessionResult.initPhases,
        phase: sessionResult.phase,
        orchestration,
        cwd: parsed.cwd ?? runtime.identity.cwd,
        initialMessage,
        verbose: parsed.verbose,
        openSession: (sessionId) => openEmbeddedSession(sessionId),
        createSession: () => openEmbeddedSession(undefined),
        onSessionChange: (next) => {
          sessionResult = next;
          session = next.session;
          orchestration = next.orchestration;
          rememberSessionEventBaseline(next.session.sessionManager.getSessionId());
        },
      };
      await interactiveRuntime.runCliInteractiveSessionOperation(session, interactiveOptions);
      printCostSummary(getSessionId(), runtime);
      return;
    }

    if (mode === "print-json") {
      await runCliPrintSession(printSession, {
        mode: "json",
        initialMessage,
        runtime,
      });
      emitJsonBundle = true;
    } else {
      await runCliPrintSession(printSession, {
        mode: "text",
        initialMessage,
        runtime,
      });
      printCostSummary(getSessionId(), runtime);
    }
  } catch (error) {
    if (!terminatedBySignal) {
      recordAbnormalSessionShutdown(runtime, {
        sessionId: getSessionId(),
        source: "cli_run_error",
        error,
      });
    }
    throw error;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (!terminatedBySignal) {
      const sessionId = getSessionId();
      if (hasSessionPersistedActivity(sessionId)) {
        recordSessionShutdownIfMissing(runtime, {
          sessionId,
          reason: resolveCliSessionCompleteReason(runtime, sessionId),
          source: "cli_embedded_session",
        });
      }
      if (emitJsonBundle) {
        const replayEvents = runtime.inspect.events.records.queryStructured(sessionId);
        await writeJsonLine({
          schema: "brewva.stream.v1",
          type: "brewva_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: runtime.inspect.cost.summary.get(sessionId),
        });
      }
      session.dispose();
    }
  }
}

export function runCliRootEffect(): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() => runCliRootOperation());
}
