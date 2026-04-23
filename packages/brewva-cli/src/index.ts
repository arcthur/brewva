#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  recordAbnormalSessionShutdown,
  recordSessionShutdownIfMissing,
  recordSessionTurnTransition,
  runChannelMode,
  runGatewayCli,
} from "@brewva/brewva-gateway";
import { DEFAULT_HOSTED_ROUTING_SCOPES } from "@brewva/brewva-gateway/host";
import {
  BrewvaConfigLoadError,
  BrewvaRuntime,
  createOperatorRuntimePort,
  createTrustedLocalGovernancePort,
  normalizeAgentId,
  parseTaskSpec,
  type ManagedToolMode,
  type RuntimeResult,
  type TaskSpec,
} from "@brewva/brewva-runtime";
import { formatISO } from "date-fns";
import { createAgentOverlaysCommandRuntimePlugin } from "./agent-overlays-command-runtime-plugin.js";
import type { CliInteractiveSessionOptions } from "./cli-runtime.js";
import { runCliPrintSession } from "./cli-runtime.js";
import { runCredentialsCli } from "./credentials.js";
import { runDaemon } from "./daemon-mode.js";
import {
  resolveBackendWorkingCwd,
  shouldFallbackAfterGatewayFailure,
  tryGatewayPrint,
  writeGatewayAssistantText,
} from "./gateway-print.js";
import { handleInsightsChannelCommand } from "./insights-channel-command.js";
import { createInsightsCommandRuntimePlugin } from "./insights-command-runtime-plugin.js";
import { runInsightsCli } from "./insights.js";
import { handleInspectChannelCommand } from "./inspect-channel-command.js";
import { createInspectCommandRuntimePlugin } from "./inspect-command-runtime-plugin.js";
import { resolveTargetSession, runInspectCli } from "./inspect.js";
import { resolveEffectiveCliMode } from "./interactive-mode.js";
import { writeJsonLine } from "./json-lines.js";
import { runOnboardCli } from "./onboard.js";
import { handleQuestionsChannelCommand } from "./questions-channel-command.js";
import { createQuestionsCommandRuntimePlugin } from "./questions-command-runtime-plugin.js";
import { createBrewvaSession } from "./session.js";
import { createUpdateCommandRuntimePlugin } from "./update-command-runtime-plugin.js";

const NODE_VERSION_RANGE = "^20.19.0 || >=22.12.0";
const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";
const BREWVA_OPENTUI_UNSUPPORTED_MESSAGE =
  "Interactive shell is not available on this Brewva build target yet. Use --print/--mode json or a promoted glibc/macOS build.";

type CliInteractiveShellRuntimeModule = typeof import("@brewva/brewva-cli/internal-shell-runtime");

type Semver = Readonly<{ major: number; minor: number; patch: number }>;

function parseSemver(versionText: string | undefined): Semver | null {
  if (typeof versionText !== "string" || versionText.length === 0) return null;
  const normalized = versionText.startsWith("v") ? versionText.slice(1) : versionText;
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(normalized);
  if (!match?.groups) return null;

  const major = Number(match.groups.major);
  const minor = Number(match.groups.minor);
  const patch = Number(match.groups.patch);

  if (!Number.isInteger(major) || major < 0) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;
  if (!Number.isInteger(patch) || patch < 0) return null;

  return { major, minor, patch };
}

function isSupportedNodeVersion(version: Semver): boolean {
  if (version.major === 20) return version.minor >= 19;
  if (version.major === 21) return false;
  if (version.major === 22) return version.minor >= 12;
  return version.major > 22;
}

function assertSupportedRuntime(): void {
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  if (typeof versions.bun === "string" && versions.bun.length > 0) return;

  const detected = typeof versions.node === "string" ? versions.node : process.version;
  const parsed = parseSemver(versions.node ?? process.version);
  if (!parsed || !isSupportedNodeVersion(parsed)) {
    console.error(
      `brewva: unsupported Node.js version ${detected}. Brewva requires Node.js ${NODE_VERSION_RANGE} (ES2023 baseline).`,
    );
    process.exit(1);
  }

  if (
    typeof Array.prototype.toSorted !== "function" ||
    typeof Array.prototype.toReversed !== "function"
  ) {
    console.error(
      `brewva: Node.js ${detected} is missing ES2023 builtins (toSorted/toReversed). Please upgrade Node.js to ${NODE_VERSION_RANGE}.`,
    );
    process.exit(1);
  }
}

function printStartupError(error: unknown): void {
  if (error instanceof BrewvaConfigLoadError) {
    console.error(`[config:error] ${error.configPath}: ${error.message}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
}

type CliValueResult<T> = RuntimeResult<{ value: T }>;

function okCliValue<T>(value: T): CliValueResult<T> {
  return { ok: true, value };
}

function cliValueError(error: string): CliValueResult<never> {
  return { ok: false, error };
}

function resolveCorrectionSession(
  runtime: BrewvaRuntime,
  operation: "undo" | "redo",
  preferredSessionId?: string,
): string | undefined {
  if (preferredSessionId) {
    const state = runtime.inspect.correction.getState(preferredSessionId);
    if (state.checkpoints.length > 0 || state.undoAvailable || state.redoAvailable) {
      return preferredSessionId;
    }
    return undefined;
  }
  let selected: { sessionId: string; timestamp: number } | undefined;
  for (const sessionId of runtime.inspect.events.listSessionIds()) {
    const state = runtime.inspect.correction.getState(sessionId);
    const candidate = operation === "redo" ? state.nextRedoable : state.latestUndoable;
    if (!candidate) {
      continue;
    }
    const timestamp =
      operation === "redo"
        ? (candidate.undoneAt ?? candidate.timestamp)
        : (candidate.redoneAt ?? candidate.timestamp);
    if (!selected || timestamp > selected.timestamp) {
      selected = { sessionId, timestamp };
    }
  }
  return selected?.sessionId;
}

function printHelp(): void {
  console.log(`Brewva - AI-native coding agent CLI

Usage:
  brewva [options] [prompt]

Subcommands:
  brewva credentials ...  Encrypted credential vault management
  brewva gateway ...   Local control-plane daemon commands
  brewva inspect ...   Replay-first session inspection with deterministic analysis
  brewva insights ...  Multi-session aggregated project insights
  brewva onboard ...   One-shot onboarding helpers (daemon install/uninstall)

Modes:
  default               Interactive shell mode
  --print               One-shot mode (prints final answer and exits)
  --mode json           One-shot JSON event stream

Options:
  --cwd <path>          Working directory
  --config <path>       Brewva config path (default: .brewva/brewva.json)
  --model <id>          Model override (exact model id or provider/id, plus optional :thinking)
  --agent <id>          Agent self bundle id (.brewva/agents/<id>/{identity,constitution,memory}.md)
  --task <json>         TaskSpec JSON (schema: brewva.task.v1)
  --task-file <path>    TaskSpec JSON file
  --managed-tools <runtime_plugin|direct>
                       Register managed Brewva tools through the hosted runtime plugin or provide them directly (default: runtime_plugin)
  --print, -p           Run one-shot mode
  --interactive, -i     Force interactive shell mode
  --mode <text|json>    One-shot output mode
  --backend <kind>      Session backend: auto | embedded | gateway (default: auto)
  --json                Alias for --mode json
  --undo                Undo the latest correction checkpoint in this session
  --redo                Redo the latest undone correction checkpoint in this session
  --replay              Replay persisted runtime events
  --daemon              Run scheduler daemon (no interactive session)
  --channel <name>      Run channel host mode (currently: telegram)
  --telegram-token <t>  Telegram bot token for --channel telegram
  --telegram-callback-secret <s>
                        Secret used to sign/verify Telegram approval callbacks
  --telegram-poll-timeout <seconds>
                        Telegram getUpdates timeout in seconds
  --telegram-poll-limit <n>
                        Telegram getUpdates batch size (1-100)
  --telegram-poll-retry-ms <ms>
                        Delay before retry when polling fails
  --session <id>        Target session id for interactive resume, --undo, --redo, or --replay
  --verbose             Verbose interactive startup
  -v, --version         Show CLI version
  -h, --help            Show help

Examples:
  brewva
  brewva "Fix failing tests in runtime"
  brewva --print "Refactor this function"
  brewva --backend gateway --print "Summarize this file"
  brewva --agent code-reviewer --print "Review recent diff"
  brewva --mode json "Summarize recent changes"
  brewva --task-file ./task.json
  brewva inspect --session <session-id>
  brewva inspect packages/brewva-runtime/src
  brewva credentials list
  brewva credentials add --ref vault://openai/apiKey --from-env OPENAI_API_KEY
  brewva --undo --session <session-id>
  brewva --redo --session <session-id>
  brewva --replay --mode json --session <session-id>
  brewva onboard --install-daemon
  brewva --channel telegram --telegram-token <bot-token>
  brewva --daemon`);
}

function readCliVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall back to unknown version when package metadata cannot be read.
  }
  return "unknown";
}

const CLI_VERSION = readCliVersion();
const CLI_TRUSTED_LOCAL_GOVERNANCE = { profile: "personal" } as const;

function printVersion(): void {
  console.log(CLI_VERSION);
}

const loadCliInteractiveRuntime: () => Promise<CliInteractiveShellRuntimeModule> =
  process.env.BREWVA_OPENTUI_SUPPORTED === "0"
    ? async () => {
        throw new Error(BREWVA_OPENTUI_UNSUPPORTED_MESSAGE);
      }
    : async () => await import("@brewva/brewva-cli/internal-shell-runtime");

type CliMode = "interactive" | "print-text" | "print-json";
type CliBackendKind = "auto" | "embedded" | "gateway";

interface TelegramCliChannelConfig {
  token?: string;
  callbackSecret?: string;
  pollTimeoutSeconds?: number;
  pollLimit?: number;
  pollRetryMs?: number;
}

interface CliChannelConfig {
  telegram?: TelegramCliChannelConfig;
}

interface CliArgs {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  taskJson?: string;
  taskFile?: string;
  channel?: string;
  channelConfig?: CliChannelConfig;
  managedToolMode: ManagedToolMode;
  undo: boolean;
  redo: boolean;
  replay: boolean;
  daemon: boolean;
  sessionId?: string;
  mode: CliMode;
  backend: CliBackendKind;
  modeExplicit: boolean;
  verbose: boolean;
  prompt?: string;
}

type CliParseResult =
  | { kind: "ok"; args: CliArgs }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error" };

const CLI_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  agent: { type: "string" },
  task: { type: "string" },
  "task-file": { type: "string" },
  "managed-tools": { type: "string" },
  print: { type: "boolean", short: "p" },
  interactive: { type: "boolean", short: "i" },
  mode: { type: "string" },
  backend: { type: "string" },
  json: { type: "boolean" },
  undo: { type: "boolean" },
  redo: { type: "boolean" },
  replay: { type: "boolean" },
  daemon: { type: "boolean" },
  channel: { type: "string" },
  "telegram-token": { type: "string" },
  "telegram-callback-secret": { type: "string" },
  "telegram-poll-timeout": { type: "string" },
  "telegram-poll-limit": { type: "string" },
  "telegram-poll-retry-ms": { type: "string" },
  session: { type: "string" },
  verbose: { type: "boolean" },
} as const;

const ROOT_SUBCOMMANDS = new Set(["credentials", "gateway", "inspect", "insights", "onboard"]);

function resolveCliRootOptionSpec(token: string): {
  kind: "string" | "boolean";
  consumesInlineValue: boolean;
} | null {
  if (token.startsWith("--")) {
    const [name, inlineValue] = token.slice(2).split("=", 2);
    const spec = CLI_PARSE_OPTIONS[name as keyof typeof CLI_PARSE_OPTIONS];
    if (!spec) {
      return null;
    }
    return {
      kind: spec.type,
      consumesInlineValue: inlineValue !== undefined,
    };
  }

  if (!token.startsWith("-") || token.length !== 2) {
    return null;
  }

  const short = token.slice(1);
  for (const spec of Object.values(CLI_PARSE_OPTIONS)) {
    if ("short" in spec && spec.short === short) {
      return {
        kind: spec.type,
        consumesInlineValue: false,
      };
    }
  }
  return null;
}

function resolveRootSubcommand(argv: string[]): { name: string; args: string[] } | undefined {
  const prefix: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("-")) {
      if (!ROOT_SUBCOMMANDS.has(token)) {
        return undefined;
      }
      return {
        name: token,
        args: [...prefix, ...argv.slice(index + 1)],
      };
    }

    const spec = resolveCliRootOptionSpec(token);
    if (!spec) {
      return undefined;
    }
    prefix.push(token);
    if (spec.kind === "string" && !spec.consumesInlineValue) {
      const next = argv[index + 1];
      if (next === undefined) {
        return undefined;
      }
      prefix.push(next);
      index += 1;
    }
  }
  return undefined;
}

function resolveModeFromFlag(value: string): CliMode | null {
  if (value === "text") return "print-text";
  if (value === "json") return "print-json";
  console.error(`Error: --mode must be "text" or "json" (received "${value}").`);
  return null;
}

function resolveBackendFromFlag(value: string | undefined): CliBackendKind | null {
  if (!value) return "auto";
  if (value === "auto" || value === "embedded" || value === "gateway") {
    return value;
  }
  console.error(`Error: --backend must be "auto", "embedded", or "gateway" (received "${value}").`);
  return null;
}

function describeFlagValue(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  try {
    return JSON.stringify(raw) ?? typeof raw;
  } catch {
    return typeof raw;
  }
}

function resolveManagedToolModeFlag(raw: unknown): CliValueResult<ManagedToolMode> {
  if (raw === undefined) {
    return okCliValue("runtime_plugin");
  }
  if (raw === "runtime_plugin" || raw === "direct") {
    return okCliValue(raw);
  }
  return cliValueError(
    `Error: --managed-tools must be "runtime_plugin" or "direct" (received "${describeFlagValue(raw)}").`,
  );
}

function parseOptionalIntegerFlag(name: string, raw: unknown): CliValueResult<number | undefined> {
  if (typeof raw !== "string") {
    return okCliValue(undefined);
  }
  const normalized = raw.trim();
  if (!normalized) {
    return cliValueError(`Error: --${name} must be an integer.`);
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return cliValueError(`Error: --${name} must be an integer.`);
  }
  return okCliValue(value);
}

function parseCliArgs(argv: string[]): CliParseResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: CLI_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    printHelp();
    return { kind: "error" };
  }

  if (parsed.values.help === true) {
    printHelp();
    return { kind: "help" };
  }
  if (parsed.values.version === true) {
    printVersion();
    return { kind: "version" };
  }

  let mode: CliMode = "interactive";
  let modeExplicit = false;
  for (const token of parsed.tokens ?? []) {
    if (token.kind !== "option") continue;
    if (token.name === "print") {
      mode = "print-text";
      modeExplicit = true;
      continue;
    }
    if (token.name === "interactive") {
      mode = "interactive";
      modeExplicit = true;
      continue;
    }
    if (token.name === "json") {
      mode = "print-json";
      modeExplicit = true;
      continue;
    }
    if (token.name === "mode") {
      if (typeof token.value !== "string") continue;
      const resolved = resolveModeFromFlag(token.value);
      if (!resolved) return { kind: "error" };
      mode = resolved;
      modeExplicit = true;
    }
  }
  const backend = resolveBackendFromFlag(
    typeof parsed.values.backend === "string" ? parsed.values.backend : undefined,
  );
  if (!backend) {
    return { kind: "error" };
  }
  const managedToolMode = resolveManagedToolModeFlag(parsed.values["managed-tools"]);
  if (!managedToolMode.ok) {
    console.error(managedToolMode.error);
    return { kind: "error" };
  }

  const prompt = parsed.positionals.join(" ").trim() || undefined;
  const pollTimeout = parseOptionalIntegerFlag(
    "telegram-poll-timeout",
    parsed.values["telegram-poll-timeout"],
  );
  if (!pollTimeout.ok) {
    console.error(pollTimeout.error);
    return { kind: "error" };
  }
  const pollLimit = parseOptionalIntegerFlag(
    "telegram-poll-limit",
    parsed.values["telegram-poll-limit"],
  );
  if (!pollLimit.ok) {
    console.error(pollLimit.error);
    return { kind: "error" };
  }
  const pollRetryMs = parseOptionalIntegerFlag(
    "telegram-poll-retry-ms",
    parsed.values["telegram-poll-retry-ms"],
  );
  if (!pollRetryMs.ok) {
    console.error(pollRetryMs.error);
    return { kind: "error" };
  }
  const args: CliArgs = {
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    model: typeof parsed.values.model === "string" ? parsed.values.model : undefined,
    agentId:
      typeof parsed.values.agent === "string" && parsed.values.agent.trim().length > 0
        ? normalizeAgentId(parsed.values.agent)
        : undefined,
    taskJson: typeof parsed.values.task === "string" ? parsed.values.task : undefined,
    taskFile:
      typeof parsed.values["task-file"] === "string" ? parsed.values["task-file"] : undefined,
    channel: typeof parsed.values.channel === "string" ? parsed.values.channel : undefined,
    channelConfig: {
      telegram: {
        token:
          typeof parsed.values["telegram-token"] === "string"
            ? parsed.values["telegram-token"]
            : undefined,
        callbackSecret:
          typeof parsed.values["telegram-callback-secret"] === "string"
            ? parsed.values["telegram-callback-secret"]
            : undefined,
        pollTimeoutSeconds: pollTimeout.value,
        pollLimit: pollLimit.value,
        pollRetryMs: pollRetryMs.value,
      },
    },
    managedToolMode: managedToolMode.value,
    undo: parsed.values.undo === true,
    redo: parsed.values.redo === true,
    replay: parsed.values.replay === true,
    daemon: parsed.values.daemon === true,
    sessionId: typeof parsed.values.session === "string" ? parsed.values.session : undefined,
    mode,
    backend,
    modeExplicit,
    verbose: parsed.values.verbose === true,
    prompt,
  };

  if ((args.undo ? 1 : 0) + (args.redo ? 1 : 0) + (args.replay ? 1 : 0) > 1) {
    console.error("Error: --undo, --redo, and --replay cannot be combined.");
    return { kind: "error" };
  }
  if ((args.undo || args.redo || args.replay) && (args.taskJson || args.taskFile)) {
    console.error("Error: --undo/--redo/--replay cannot be combined with --task/--task-file.");
    return { kind: "error" };
  }
  if (args.channel?.trim().toLowerCase() === "telegram") {
    const token = args.channelConfig?.telegram?.token?.trim();
    if (!token) {
      console.error("Error: --telegram-token is required when --channel telegram is set.");
      return { kind: "error" };
    }
  }

  return { kind: "ok", args };
}

function parseArgs(argv: string[]): CliArgs | null {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "ok") {
    return null;
  }
  return parsed.args;
}

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
    return cliValueError(`Error: invalid TaskSpec: ${result.error}`);
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

function printCostSummary(sessionId: string, runtime: BrewvaRuntime): void {
  const summary = runtime.inspect.cost.getSummary(sessionId);
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
  const runtime = new BrewvaRuntime({
    cwd: resolveBackendWorkingCwd(input.cwd),
    configPath: input.configPath,
    governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
  });
  runtime.maintain.context.onTurnStart(replaySessionId, 0);
  printCostSummary(replaySessionId, runtime);
}

function resolveCliSessionCompleteReason(runtime: BrewvaRuntime, sessionId: string): string {
  const events = runtime.inspect.events.queryStructured(sessionId);
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

async function run(): Promise<void> {
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
    const gatewayResult = await runGatewayCli(subcommand.args);
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
    process.exitCode = await runOnboardCli(subcommand.args);
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
    const runtime = new BrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
    });
    const targetSessionId = resolveTargetSession(runtime, parsed.sessionId);
    if (!targetSessionId) {
      console.error("Error: no replayable session found.");
      process.exitCode = 1;
      return;
    }
    const events = runtime.inspect.events.queryStructured(targetSessionId);
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
    const runtime = new BrewvaRuntime({
      cwd: parsed.cwd,
      configPath: parsed.configPath,
      governancePort: createTrustedLocalGovernancePort(CLI_TRUSTED_LOCAL_GOVERNANCE),
    });
    const targetSessionId = resolveCorrectionSession(
      runtime,
      parsed.redo ? "redo" : "undo",
      parsed.sessionId,
    );
    if (!targetSessionId) {
      console.log(`No correction ${parsed.redo ? "redo" : "undo"} applied (no_checkpoint).`);
      return;
    }
    const result = parsed.redo
      ? runtime.authority.correction.redo(targetSessionId)
      : runtime.authority.correction.undo(targetSessionId);
    if (!result.ok) {
      console.log(`No correction ${parsed.redo ? "redo" : "undo"} applied (${result.reason}).`);
    } else {
      const promptSuffix = result.restoredPrompt?.text
        ? ` Restored prompt: ${result.restoredPrompt.text.trim()}`
        : "";
      console.log(
        `Correction ${parsed.redo ? "redo" : "undo"} applied in session ${targetSessionId} (${result.patchSetIds.length} patch set(s)).${promptSuffix}`,
      );
    }
    return;
  }

  const pipedInput = await readPipedStdin();
  const taskResolved = loadTaskSpec(parsed);
  if (!taskResolved.ok) {
    console.error(taskResolved.error);
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

  const runtime = new BrewvaRuntime({
    cwd: parsed.cwd,
    configPath: parsed.configPath,
    agentId: parsed.agentId,
    governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    routingDefaultScopes: [...DEFAULT_HOSTED_ROUTING_SCOPES],
  });
  const operatorRuntime = createOperatorRuntimePort(runtime);
  const createRuntimePlugins = () => [
    createInspectCommandRuntimePlugin(operatorRuntime),
    createInsightsCommandRuntimePlugin(operatorRuntime),
    createQuestionsCommandRuntimePlugin(runtime),
    createAgentOverlaysCommandRuntimePlugin(runtime),
    createUpdateCommandRuntimePlugin(runtime),
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
      internalRuntimePlugins: createRuntimePlugins(),
    });
  let sessionResult = await openEmbeddedSession(parsed.sessionId);
  let session = sessionResult.session;
  let orchestration = sessionResult.orchestration;
  const printSession = session;

  const getSessionId = (): string => session.sessionManager.getSessionId();
  const initialSessionId = getSessionId();
  if (taskSpec) {
    runtime.authority.task.setSpec(initialSessionId, taskSpec);
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
    recordSessionShutdownIfMissing(runtime, {
      sessionId: getSessionId(),
      reason: shutdownReceipt?.reason ?? "cli_session_terminated",
      source: shutdownReceipt?.source ?? "cli_embedded_session",
    });
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
    let signalTransitionFinalized = false;
    const finalizeSignalTransition = (status: "completed" | "failed", error?: string): void => {
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
    recordSessionTurnTransition(runtime, {
      sessionId,
      reason: "signal_interrupt",
      status: "entered",
      family: "interrupt",
      error: signal,
    });

    const timeout = setTimeout(() => {
      void session
        .abort()
        .then(() => {
          finalizeSignalTransition("completed");
        })
        .catch((error) => {
          finalizeSignalTransition(
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          finalizeAndExit(130);
        });
    }, gracefulTimeoutMs);

    void session
      .waitForIdle()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
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
        orchestration,
        cwd: parsed.cwd ?? runtime.cwd,
        initialMessage,
        verbose: parsed.verbose,
        openSession: (sessionId) => openEmbeddedSession(sessionId),
        createSession: () => openEmbeddedSession(undefined),
        onSessionChange: (next) => {
          sessionResult = next;
          session = next.session;
          orchestration = next.orchestration;
        },
      };
      await interactiveRuntime.runCliInteractiveSession(session, interactiveOptions);
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
      recordSessionShutdownIfMissing(runtime, {
        sessionId,
        reason: resolveCliSessionCompleteReason(runtime, sessionId),
        source: "cli_embedded_session",
      });
      if (emitJsonBundle) {
        const replayEvents = runtime.inspect.events.queryStructured(sessionId);
        await writeJsonLine({
          schema: "brewva.stream.v1",
          type: "brewva_event_bundle",
          sessionId,
          events: replayEvents,
          costSummary: runtime.inspect.cost.getSummary(sessionId),
        });
      }
      session.dispose();
    }
  }
}

const isBunMain = (import.meta as ImportMeta & { main?: boolean }).main;
const isNodeMain = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isBunMain ?? isNodeMain) {
  assertSupportedRuntime();
  void run().catch((error) => {
    printStartupError(error);
    process.exitCode = 1;
  });
}

export { parseArgs };
export { handleInspectChannelCommand } from "./inspect-channel-command.js";
export { createInspectCommandRuntimePlugin } from "./inspect-command-runtime-plugin.js";
export { handleInsightsChannelCommand } from "./insights-channel-command.js";
export { createInsightsCommandRuntimePlugin } from "./insights-command-runtime-plugin.js";
export { handleQuestionsChannelCommand } from "./questions-channel-command.js";
export { createQuestionsCommandRuntimePlugin } from "./questions-command-runtime-plugin.js";
export { createAgentOverlaysCommandRuntimePlugin } from "./agent-overlays-command-runtime-plugin.js";
export { createUpdateCommandRuntimePlugin } from "./update-command-runtime-plugin.js";
export { runInsightsCli } from "./insights.js";
export { runOnboardCli } from "./onboard.js";
export { JsonLineWriter, type JsonLineWritable, writeJsonLine } from "./json-lines.js";
export {
  resolveBackendWorkingCwd,
  resolveGatewayFailureStage,
  shouldFallbackAfterGatewayFailure,
} from "./gateway-print.js";
