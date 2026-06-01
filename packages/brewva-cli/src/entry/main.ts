import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { startBoundaryTimeout, type BoundaryTimeoutHandle } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import {
  recordAbnormalSessionShutdown,
  recordSessionShutdownIfMissing,
} from "@brewva/brewva-gateway";
import { runGatewayCliOperation } from "@brewva/brewva-gateway/admin";
import { runChannelMode } from "@brewva/brewva-gateway/channels";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeResult } from "@brewva/brewva-runtime/core";
import { projectDelegationInspectionState } from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { normalizeTaskSpec } from "@brewva/brewva-vocabulary/task";
import type { TaskSpec } from "@brewva/brewva-vocabulary/task";
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
import {
  getCliRuntimeCostSummary,
  getCliRuntimeRewindState,
  listCliRuntimeEvents,
  listCliRuntimeEventSessionIds,
  queryCliStructuredRuntimeEvents,
  setCliRuntimeTaskSpec,
} from "../runtime/runtime-ports.js";
import type { CliInteractiveSessionOptions } from "../session/cli-runtime.js";
import { runCliPrintSession } from "../session/cli-runtime.js";
import { createBrewvaSession } from "../session/session.js";
import { parseCliArgs, resolveRootSubcommand, type CliArgs, type CliMode } from "./args.js";
import { printHelp } from "./help.js";
import { resolveEffectiveCliMode } from "./mode.js";
export { parseArgs } from "./args.js";
export { assertSupportedRuntime, printStartupError } from "./runtime-guard.js";

const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";
const BREWVA_OPENTUI_UNSUPPORTED_MESSAGE =
  "Interactive shell is not available on this Brewva build target yet. Use --print/--mode json or a promoted glibc/macOS build.";

type CliInteractiveShellRuntimeModule = typeof import("@brewva/brewva-cli/internal-shell-runtime");

type CliValueResult<T> = RuntimeResult<{ value: T }>;
type TaskSpecParseResult =
  | { readonly ok: true; readonly spec: TaskSpec }
  | { readonly ok: false; readonly reason: string };

function okCliValue<T>(value: T): CliValueResult<T> {
  return { ok: true, value };
}

function parseTaskSpec(value: unknown): TaskSpecParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "TaskSpec must be an object" };
  }
  return { ok: true, spec: normalizeTaskSpec(value) };
}

async function runInsightsCli(argv: string[]): Promise<number> {
  const { runInsightsCli: loadedRunInsightsCli } = await import("../operator/insights.js");
  return loadedRunInsightsCli(argv);
}

async function runHarnessCli(argv: string[]): Promise<number> {
  const { runHarnessCli: loadedRunHarnessCli } = await import("../operator/harness.js");
  return loadedRunHarnessCli(argv);
}

function cliValueError(error: string): CliValueResult<never> {
  return { ok: false, reason: error };
}

function resolveSessionRewindSession(
  runtime: HostedRuntimeAdapterPort,
  operation: "undo" | "redo",
  preferredSessionId?: string,
): string | undefined {
  if (preferredSessionId) {
    const state = getCliRuntimeRewindState(runtime, preferredSessionId);
    if (state.checkpoints.length > 0 || state.rewindAvailable || state.redoAvailable) {
      return preferredSessionId;
    }
    return undefined;
  }
  let selected: { sessionId: string; timestamp: number } | undefined;
  for (const sessionId of listCliRuntimeEventSessionIds(runtime)) {
    const state = getCliRuntimeRewindState(runtime, sessionId);
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

export function formatReplayTimelineText(
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): string {
  const timeline = projectDelegationInspectionState({ sessionId, records: events }).timeline;
  return timeline.groups
    .map((group) => {
      const iso = formatISO(group.timestamp);
      const turnText = typeof group.turn === "number" ? `turn=${group.turn}` : "turn=-";
      return `${iso} ${turnText} kind=${group.kind} events=${group.eventIds.join(",")} refs=${group.canonicalRefs.join(",")} ${group.summary}`;
    })
    .join("\n");
}

export function formatReplayRawText(events: readonly BrewvaEventRecord[]): string {
  return events
    .map((event) => {
      const iso = event.isoTime ?? formatISO(event.timestamp);
      const turnText = typeof event.turn === "number" ? `turn=${event.turn}` : "turn=-";
      return `${iso} ${turnText} type=${event.type} payload=${JSON.stringify(event.payload ?? {})}`;
    })
    .join("\n");
}

function printReplayText(events: readonly BrewvaEventRecord[]): void {
  const text = formatReplayRawText(events);
  if (text.length > 0) {
    console.log(text);
  }
}

function printReplayTimelineText(sessionId: string, events: readonly BrewvaEventRecord[]): void {
  const text = formatReplayTimelineText(sessionId, events);
  if (text.length > 0) {
    console.log(text);
  }
}

function toReplayEventRecords(
  sessionId: string,
  events: readonly {
    readonly id?: string;
    readonly sessionId?: string;
    readonly schema?: string;
    readonly turnId?: string;
    readonly turn?: number;
    readonly category?: string;
    readonly type: string;
    readonly timestamp: number;
    readonly isoTime?: string;
    readonly source?: string;
    readonly payload?: unknown;
  }[],
): BrewvaEventRecord[] {
  return events.map((event, index) => ({
    id: event.id ?? `event_${index + 1}`,
    sessionId: event.sessionId ?? sessionId,
    schema: typeof event.schema === "string" ? event.schema : "brewva.event.v1",
    ...(typeof event.turnId === "string" ? { turnId: event.turnId } : {}),
    ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
    ...(typeof event.category === "string" ? { category: event.category } : {}),
    type: event.type,
    timestamp: event.timestamp,
    isoTime:
      typeof event.isoTime === "string" ? event.isoTime : new Date(event.timestamp).toISOString(),
    ...(typeof event.source === "string" ? { source: event.source } : {}),
    payload:
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {},
  }));
}

function printCostSummary(sessionId: string, runtime: HostedRuntimeAdapterPort): void {
  const summary = getCliRuntimeCostSummary(runtime, sessionId) as {
    totalTokens: number;
    totalCostUsd: number;
    budget: { blocked: boolean };
    skills: Record<string, { totalCostUsd: number }>;
    tools: Record<string, { allocatedCostUsd: number }>;
  };
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
  const runtime = createHostedRuntimeAdapter({
    cwd: resolveBackendWorkingCwd(input.cwd),
    configPath: input.configPath,
  });
  runtime.ops.context.lifecycle.onTurnStart(replaySessionId, 0);
  printCostSummary(replaySessionId, runtime);
}

function resolveCliSessionCompleteReason(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): string {
  const events = queryCliStructuredRuntimeEvents(runtime, sessionId);
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
      "Error: unknown subcommand. Use 'brewva credentials', 'brewva harness', 'brewva inspect', 'brewva insights', 'brewva onboard', or 'brewva gateway'.",
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
  if (subcommand?.name === "harness") {
    process.exitCode = await runHarnessCli(subcommand.args);
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
    const runtime = createHostedRuntimeAdapter({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
    });
    const targetSessionId = parsed.sessionId ?? resolveTargetSession(runtime, undefined);
    if (!targetSessionId) {
      console.error("Error: no replayable session found.");
      process.exitCode = 1;
      return;
    }
    const canonicalRuntime = createBrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      physics: { mode: "noop" },
    });
    await canonicalRuntime.start();
    const canonicalEvents = canonicalRuntime.tape.list(targetSessionId);
    const events =
      canonicalEvents.length > 0
        ? canonicalEvents
        : queryCliStructuredRuntimeEvents(runtime, targetSessionId);
    const replayEvents = toReplayEventRecords(targetSessionId, events);
    const timeline = parsed.replayTimeline
      ? projectDelegationInspectionState({
          sessionId: targetSessionId,
          records: replayEvents,
        }).timeline
      : undefined;
    if (replayMode === "print-json") {
      if (parsed.replayTimeline) {
        for (const group of timeline?.groups ?? []) {
          await writeJsonLine(group);
        }
      } else {
        for (const event of replayEvents) {
          await writeJsonLine(event);
        }
      }
    } else if (parsed.replayTimeline) {
      printReplayTimelineText(targetSessionId, replayEvents);
    } else {
      printReplayText(replayEvents);
    }
    return;
  }

  if (parsed.undo || parsed.redo) {
    const runtime = createHostedRuntimeAdapter({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
    });
    const targetSessionId = resolveSessionRewindSession(
      runtime,
      parsed.redo ? "redo" : "undo",
      parsed.sessionId,
    );
    if (!targetSessionId) {
      console.log(`No session ${parsed.redo ? "redo" : "undo"} applied (no_checkpoint).`);
      return;
    }
    const result = parsed.redo
      ? runtime.ops.session.rewind.redo(targetSessionId)
      : runtime.ops.session.rewind.rewind(targetSessionId, {
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

  const runtimeInstance = createHostedRuntimeAdapter({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    agentId: parsed.agentId,
  });
  const runtime = runtimeInstance;
  const operatorRuntime = runtimeInstance;
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
    sessionEventBaselineById.set(sessionId, listCliRuntimeEvents(runtime, sessionId).length);
  };
  const hasSessionPersistedActivity = (sessionId: string): boolean => {
    const baseline = sessionEventBaselineById.get(sessionId) ?? 0;
    return listCliRuntimeEvents(runtime, sessionId).length > baseline;
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
    setCliRuntimeTaskSpec(runtime, initialSessionId, taskSpec);
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

    const timeout: BoundaryTimeoutHandle = startBoundaryTimeout({
      delayMs: gracefulTimeoutMs,
      run: () =>
        BrewvaEffect.promise(async () => {
          try {
            await session.abort();
          } catch {
            // The shutdown receipt is the durable interruption fact for this edge.
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
        const replayEvents = queryCliStructuredRuntimeEvents(runtime, sessionId);
        await writeJsonLine({
          schema: "brewva.stream.v1",
          type: "brewva_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: getCliRuntimeCostSummary(runtime, sessionId),
        });
      }
      session.dispose();
    }
  }
}

export function runCliRootEffect(): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() => runCliRootOperation());
}
