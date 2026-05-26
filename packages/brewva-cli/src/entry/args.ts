import { parseArgs as parseNodeArgs } from "node:util";
import type { RuntimeResult } from "@brewva/brewva-runtime/core";
import { normalizeAgentId } from "@brewva/brewva-vocabulary/session";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import { printHelp, printVersion } from "./help.js";

type CliValueResult<T> = RuntimeResult<{ value: T }>;

function okCliValue<T>(value: T): CliValueResult<T> {
  return { ok: true, value };
}

function cliValueError(error: string): CliValueResult<never> {
  return { ok: false, reason: error };
}

export type CliMode = "interactive" | "print-text" | "print-json";
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

export interface CliArgs {
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
  replayTimeline: boolean;
  daemon: boolean;
  sessionId?: string;
  mode: CliMode;
  backend: CliBackendKind;
  modeExplicit: boolean;
  verbose: boolean;
  prompt?: string;
}

export type CliParseResult =
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
  "replay-timeline": { type: "boolean" },
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

const ROOT_SUBCOMMANDS = new Set([
  "credentials",
  "gateway",
  "inspect",
  "insights",
  "onboard",
  "skills",
]);

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

export function resolveRootSubcommand(
  argv: string[],
): { name: string; args: string[] } | undefined {
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
    return okCliValue("hosted");
  }
  if (raw === "hosted" || raw === "direct") {
    return okCliValue(raw);
  }
  return cliValueError(
    `Error: --managed-tools must be "hosted" or "direct" (received "${describeFlagValue(raw)}").`,
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

export function parseCliArgs(argv: string[]): CliParseResult {
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
    console.error(managedToolMode.reason);
    return { kind: "error" };
  }

  const prompt = parsed.positionals.join(" ").trim() || undefined;
  const pollTimeout = parseOptionalIntegerFlag(
    "telegram-poll-timeout",
    parsed.values["telegram-poll-timeout"],
  );
  if (!pollTimeout.ok) {
    console.error(pollTimeout.reason);
    return { kind: "error" };
  }
  const pollLimit = parseOptionalIntegerFlag(
    "telegram-poll-limit",
    parsed.values["telegram-poll-limit"],
  );
  if (!pollLimit.ok) {
    console.error(pollLimit.reason);
    return { kind: "error" };
  }
  const pollRetryMs = parseOptionalIntegerFlag(
    "telegram-poll-retry-ms",
    parsed.values["telegram-poll-retry-ms"],
  );
  if (!pollRetryMs.ok) {
    console.error(pollRetryMs.reason);
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
    replay: parsed.values.replay === true || parsed.values["replay-timeline"] === true,
    replayTimeline: parsed.values["replay-timeline"] === true,
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

export function parseArgs(argv: string[]): CliArgs | null {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== "ok") {
    return null;
  }
  return parsed.args;
}
