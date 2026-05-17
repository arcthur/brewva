import { basename } from "node:path";

const MAX_ANALYSIS_DEPTH = 2;
const MAX_COMMAND_LENGTH = 8_192;
const MAX_PIPELINE_COMMANDS = 8;
const MAX_ARGUMENTS_PER_COMMAND = 128;
const MAX_ARGUMENT_LENGTH = 2_048;
const MAX_NETWORK_TARGETS = 16;
const URL_TOKEN_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;
const SHELL_WRAPPER_TOKENS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const PREFIX_TOKENS = new Set(["command", "time"]);
const READONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cut",
  "dirname",
  "du",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "ls",
  "pwd",
  "realpath",
  "rg",
  // sed without -i writes to stdout (readonly); sed -i triggers write effect via unsafeOptions
  "sed",
  "sort",
  "stat",
  "tail",
  "tr",
  "uniq",
  "wc",
]);
const WRITE_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "sed",
  "tee",
  "touch",
  "truncate",
]);
const NETWORK_COMMANDS = new Set(["curl", "nc", "ncat", "netcat", "ssh", "telnet", "wget"]);
const LOCAL_EXEC_COMMANDS = new Set([
  "bun",
  "deno",
  "go",
  "make",
  "node",
  "npm",
  "npx",
  "pnpm",
  "python",
  "python3",
  "ruby",
  "sh",
  "yarn",
]);

export type CommandPolicyEffect =
  | "workspace_read"
  | "workspace_write"
  | "local_exec"
  | "external_network"
  | "unsupported";

export type FilesystemIntent = "none" | "read" | "write" | "unknown";

export interface CommandPolicyUnsupportedReason {
  code: string;
  detail?: string;
  command?: string;
}

export interface CommandPolicyDiagnostic {
  code: "stderr_redirection" | "diagnostic_suppression";
  detail?: string;
}

export interface CommandPolicyNetworkTarget {
  raw: string;
  host: string;
  port?: number;
  protocol: "http" | "https";
}

export interface CommandPolicyCommand {
  name: string;
  argv: string[];
  readonly: boolean;
  effects: CommandPolicyEffect[];
  unsafeOptions: string[];
}

export interface ShellCommandAnalysis {
  commands: CommandPolicyCommand[];
  effects: CommandPolicyEffect[];
  networkTargets: CommandPolicyNetworkTarget[];
  filesystemIntent: FilesystemIntent;
  unsupportedReasons: CommandPolicyUnsupportedReason[];
  diagnostics: CommandPolicyDiagnostic[];
  readonlyEligible: boolean;
}

export interface CommandPolicySummary {
  readonlyEligible: boolean;
  commands: string[];
  effects: CommandPolicyEffect[];
  filesystemIntent: FilesystemIntent;
  unsupportedReasons: CommandPolicyUnsupportedReason[];
  diagnostics: CommandPolicyDiagnostic[];
  networkTargets: Array<{ host: string; port?: number; protocol: "http" | "https" }>;
}

interface ShellSegment {
  text: string;
  operator?: "pipe";
}

interface TokenizeResult {
  tokens: string[];
  unsupportedReasons: CommandPolicyUnsupportedReason[];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function addReason(
  reasons: CommandPolicyUnsupportedReason[],
  reason: CommandPolicyUnsupportedReason,
): void {
  if (
    reasons.some(
      (entry) =>
        entry.code === reason.code &&
        entry.detail === reason.detail &&
        entry.command === reason.command,
    )
  ) {
    return;
  }
  reasons.push(reason);
}

function addDiagnostic(
  diagnostics: CommandPolicyDiagnostic[],
  diagnostic: CommandPolicyDiagnostic,
): void {
  if (
    diagnostics.some(
      (entry) => entry.code === diagnostic.code && entry.detail === diagnostic.detail,
    )
  ) {
    return;
  }
  diagnostics.push(diagnostic);
}

function normalizeCommandName(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return "";
  return normalized.includes("/") ? basename(normalized) : normalized;
}

function parseUrlTarget(raw: string): CommandPolicyNetworkTarget | undefined {
  try {
    const parsed = new URL(raw);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return undefined;
    }
    const defaultPort = protocol === "https:" ? 443 : 80;
    const port = parsed.port.length > 0 ? Number(parsed.port) : defaultPort;
    return {
      raw,
      host: parsed.hostname.trim().toLowerCase().replace(/\.$/u, ""),
      port: Number.isFinite(port) ? port : undefined,
      protocol: protocol === "https:" ? "https" : "http",
    };
  } catch {
    return undefined;
  }
}

export function collectCommandPolicyNetworkTargets(command: string): CommandPolicyNetworkTarget[] {
  const targets: CommandPolicyNetworkTarget[] = [];
  for (const match of command.matchAll(URL_TOKEN_PATTERN)) {
    const target = parseUrlTarget(match[0]);
    if (!target) continue;
    if (targets.some((entry) => entry.host === target.host && entry.port === target.port)) {
      continue;
    }
    targets.push(target);
  }
  return targets;
}

function collectDiagnosticRedirectionRanges(command: string): {
  ranges: Array<{ start: number; end: number }>;
  diagnostics: CommandPolicyDiagnostic[];
} {
  const ranges: Array<{ start: number; end: number }> = [];
  const diagnostics: CommandPolicyDiagnostic[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== ">" || command[index - 1] !== "2") {
      continue;
    }
    let cursor = index + 1;
    if (command[cursor] === ">") {
      cursor += 1;
    }
    while (/\s/u.test(command[cursor] ?? "")) {
      cursor += 1;
    }
    const target = command.slice(cursor);
    if (target.startsWith("/dev/null")) {
      ranges.push({ start: index - 1, end: cursor + "/dev/null".length });
      addDiagnostic(diagnostics, { code: "stderr_redirection", detail: "2>/dev/null" });
      addDiagnostic(diagnostics, {
        code: "diagnostic_suppression",
        detail: "stderr_to_dev_null",
      });
      continue;
    }
    if (target.startsWith("&1")) {
      ranges.push({ start: index - 1, end: cursor + 2 });
      addDiagnostic(diagnostics, { code: "stderr_redirection", detail: "2>&1" });
    }
  }
  return { ranges, diagnostics };
}

function isInsideRange(index: number, ranges: ReadonlyArray<{ start: number; end: number }>) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function scanShellSyntax(command: string): {
  unsupportedReasons: CommandPolicyUnsupportedReason[];
  diagnostics: CommandPolicyDiagnostic[];
} {
  const reasons: CommandPolicyUnsupportedReason[] = [];
  const diagnosticRedirections = collectDiagnosticRedirectionRanges(command);
  const diagnostics = [...diagnosticRedirections.diagnostics];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === "$" && next === "(") {
        addReason(reasons, { code: "command_substitution", detail: "$(...)" });
      } else if (quote === '"' && char === "`") {
        addReason(reasons, { code: "command_substitution", detail: "`...`" });
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "$" && next === "(") {
      addReason(reasons, { code: "command_substitution", detail: "$(...)" });
      continue;
    }

    if (char === "`") {
      addReason(reasons, { code: "command_substitution", detail: "`...`" });
      continue;
    }

    if ((char === "<" || char === ">") && next === "(") {
      addReason(reasons, { code: "process_substitution", detail: `${char}(... )` });
      continue;
    }

    if (char === ">") {
      if (isInsideRange(index, diagnosticRedirections.ranges)) {
        continue;
      }
      addReason(reasons, { code: "write_redirection", detail: ">" });
      continue;
    }

    if (char === "<") {
      addReason(reasons, { code: "input_redirection", detail: "<" });
    }
  }

  if (/(^|[;&|])\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*\(\s*\)\s*\{/u.test(command)) {
    addReason(reasons, { code: "shell_function", detail: "function definition" });
  }

  return { unsupportedReasons: reasons, diagnostics };
}

function splitShellSegments(command: string): {
  segments: ShellSegment[];
  unsupportedReasons: CommandPolicyUnsupportedReason[];
} {
  const segments: ShellSegment[] = [];
  const unsupportedReasons: CommandPolicyUnsupportedReason[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = (operator?: "pipe") => {
    const text = current.trim();
    if (text.length > 0) {
      segments.push({ text, operator });
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "|" && next === "&") {
      addReason(unsupportedReasons, { code: "pipe_stderr", detail: "|&" });
      index += 1;
      push("pipe");
      continue;
    }

    if (char === "|") {
      if (next === "|") {
        addReason(unsupportedReasons, { code: "compound_control_operator", detail: "||" });
        index += 1;
        push();
      } else {
        push("pipe");
      }
      continue;
    }

    if (char === "&" && next === "&") {
      addReason(unsupportedReasons, { code: "compound_control_operator", detail: "&&" });
      index += 1;
      push();
      continue;
    }

    if (char === "&") {
      addReason(unsupportedReasons, { code: "background_operator", detail: "&" });
      continue;
    }

    if (char === ";" || char === "\n") {
      addReason(unsupportedReasons, { code: "compound_control_operator", detail: char });
      push();
      continue;
    }

    current += char;
  }

  push();
  return { segments, unsupportedReasons };
}

function tokenizeSegment(segment: string): TokenizeResult {
  const tokens: string[] = [];
  const unsupportedReasons: CommandPolicyUnsupportedReason[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      push();
      continue;
    }

    current += char;
  }

  if (quote) {
    addReason(unsupportedReasons, { code: "unterminated_quote", detail: quote });
  }
  push();
  return { tokens, unsupportedReasons };
}

function resolvePrimaryCommand(tokens: readonly string[]): {
  command?: string;
  argv: string[];
  unsupportedReasons: CommandPolicyUnsupportedReason[];
} {
  const unsupportedReasons: CommandPolicyUnsupportedReason[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    const normalized = normalizeCommandName(token);
    if (!normalized) {
      index += 1;
      continue;
    }
    if (ENV_ASSIGNMENT_TOKEN.test(token)) {
      addReason(unsupportedReasons, { code: "env_assignment", detail: "inline environment" });
      index += 1;
      continue;
    }
    if (normalized === "env") {
      addReason(unsupportedReasons, { code: "env_wrapper", detail: "env" });
      index += 1;
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (PREFIX_TOKENS.has(normalized)) {
      addReason(unsupportedReasons, { code: "command_prefix", detail: normalized });
      index += 1;
      continue;
    }
    if (normalized === "sudo") {
      addReason(unsupportedReasons, { code: "privilege_escalation", detail: "sudo" });
      index += 1;
      continue;
    }
    return {
      command: normalized,
      argv: tokens.slice(index + 1),
      unsupportedReasons,
    };
  }

  return { argv: [], unsupportedReasons };
}

function resolveShellInlineScript(command: string, argv: readonly string[]): string | undefined {
  if (!SHELL_WRAPPER_TOKENS.has(command)) {
    return undefined;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") {
      return undefined;
    }
    if (token === "-c" || token === "--command") {
      return argv[index + 1];
    }
    if (token.startsWith("--command=")) {
      return token.slice("--command=".length) || undefined;
    }
    if (token.startsWith("-") && !token.startsWith("--") && token.includes("c")) {
      const cIndex = token.indexOf("c");
      const inline = token.slice(cIndex + 1);
      return inline.length > 0 ? inline : argv[index + 1];
    }
  }

  return undefined;
}

function collectUnsafeOptions(command: string, argv: readonly string[]): string[] {
  const unsafe = new Set<string>();

  if (command === "find") {
    const unsafeFindOptions = new Set([
      "-delete",
      "-exec",
      "-execdir",
      "-fls",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-ok",
      "-okdir",
    ]);
    for (const arg of argv) {
      if (unsafeFindOptions.has(arg)) {
        unsafe.add(arg);
      }
    }
  }

  if (command === "rg") {
    for (const arg of argv) {
      if (arg === "--pre" || arg.startsWith("--pre=")) {
        unsafe.add(arg);
      }
    }
  }

  if (command === "sed") {
    for (const arg of argv) {
      if (
        arg === "-i" ||
        arg.startsWith("-i") ||
        arg === "--in-place" ||
        arg.startsWith("--in-place=")
      ) {
        unsafe.add(arg);
      }
    }
  }

  if (command === "tail") {
    for (const arg of argv) {
      if (arg === "-f" || arg === "--follow" || arg.startsWith("--follow=")) {
        unsafe.add(arg);
      }
    }
  }

  if (
    command === "xargs" &&
    argv.some((arg) => SHELL_WRAPPER_TOKENS.has(normalizeCommandName(arg)))
  ) {
    unsafe.add("xargs-shell");
  }

  return [...unsafe];
}

function classifyCommand(command: string, argv: readonly string[]): CommandPolicyCommand {
  const unsafeOptions = collectUnsafeOptions(command, argv);
  const effects = new Set<CommandPolicyEffect>();

  if (READONLY_COMMANDS.has(command)) {
    effects.add("workspace_read");
  }
  if (WRITE_COMMANDS.has(command) && unsafeOptions.length > 0) {
    effects.add("workspace_write");
  }
  if (command === "tee" || (WRITE_COMMANDS.has(command) && command !== "sed")) {
    effects.add("workspace_write");
  }
  if (NETWORK_COMMANDS.has(command)) {
    effects.add("external_network");
  }
  if (LOCAL_EXEC_COMMANDS.has(command) || !READONLY_COMMANDS.has(command)) {
    effects.add("local_exec");
  }
  if (!READONLY_COMMANDS.has(command)) {
    effects.add("unsupported");
  }
  if (unsafeOptions.length > 0) {
    effects.add("unsupported");
  }

  const readonly =
    READONLY_COMMANDS.has(command) &&
    unsafeOptions.length === 0 &&
    !effects.has("workspace_write") &&
    !effects.has("external_network") &&
    !effects.has("local_exec") &&
    !effects.has("unsupported");

  return {
    name: command,
    argv: [...argv],
    readonly,
    effects: [...effects],
    unsafeOptions,
  };
}

function mergeFilesystemIntent(
  current: FilesystemIntent,
  next: FilesystemIntent,
): FilesystemIntent {
  if (current === "write" || next === "write") return "write";
  if (current === "unknown" || next === "unknown") return "unknown";
  if (current === "read" || next === "read") return "read";
  return "none";
}

function analyzeShellCommandInternal(command: string, depth: number): ShellCommandAnalysis {
  const shellSyntax = scanShellSyntax(command);
  const unsupportedReasons = shellSyntax.unsupportedReasons;
  const diagnostics = shellSyntax.diagnostics;
  if (command.length > MAX_COMMAND_LENGTH) {
    addReason(unsupportedReasons, {
      code: "command_too_long",
      detail: String(command.length),
    });
  }
  const split = splitShellSegments(command);
  unsupportedReasons.push(...split.unsupportedReasons);
  if (split.segments.length > MAX_PIPELINE_COMMANDS) {
    addReason(unsupportedReasons, {
      code: "too_many_pipeline_commands",
      detail: String(split.segments.length),
    });
  }
  const commands: CommandPolicyCommand[] = [];
  let filesystemIntent: FilesystemIntent = "none";

  for (const segment of split.segments) {
    const tokenized = tokenizeSegment(segment.text);
    unsupportedReasons.push(...tokenized.unsupportedReasons);
    if (tokenized.tokens.length > MAX_ARGUMENTS_PER_COMMAND) {
      addReason(unsupportedReasons, {
        code: "too_many_arguments",
        detail: String(tokenized.tokens.length),
      });
    }
    for (const token of tokenized.tokens) {
      if (token.length > MAX_ARGUMENT_LENGTH) {
        addReason(unsupportedReasons, {
          code: "argument_too_long",
          detail: String(token.length),
        });
      }
    }
    const resolved = resolvePrimaryCommand(tokenized.tokens);
    unsupportedReasons.push(...resolved.unsupportedReasons);
    if (!resolved.command) {
      continue;
    }

    const commandPolicy = classifyCommand(resolved.command, resolved.argv);
    commands.push(commandPolicy);
    if (!commandPolicy.readonly) {
      if (!READONLY_COMMANDS.has(commandPolicy.name)) {
        addReason(unsupportedReasons, {
          code: "unknown_command",
          detail: commandPolicy.name,
          command: commandPolicy.name,
        });
      }
      if (commandPolicy.unsafeOptions.length > 0) {
        for (const option of commandPolicy.unsafeOptions) {
          addReason(unsupportedReasons, {
            code: "unsafe_option",
            detail: option,
            command: commandPolicy.name,
          });
        }
      }
    }

    const inlineScript = resolveShellInlineScript(commandPolicy.name, commandPolicy.argv);
    if (inlineScript) {
      addReason(unsupportedReasons, {
        code: "shell_wrapper",
        detail: commandPolicy.name,
        command: commandPolicy.name,
      });
      if (depth < MAX_ANALYSIS_DEPTH) {
        const nested = analyzeShellCommandInternal(inlineScript, depth + 1);
        for (const nestedCommand of nested.commands) {
          if (!commands.some((entry) => entry.name === nestedCommand.name)) {
            commands.push(nestedCommand);
          }
        }
        unsupportedReasons.push(...nested.unsupportedReasons);
        diagnostics.push(...nested.diagnostics);
        filesystemIntent = mergeFilesystemIntent(filesystemIntent, nested.filesystemIntent);
      }
    }

    if (commandPolicy.effects.includes("workspace_write")) {
      filesystemIntent = mergeFilesystemIntent(filesystemIntent, "write");
    } else if (commandPolicy.effects.includes("unsupported")) {
      filesystemIntent = mergeFilesystemIntent(filesystemIntent, "unknown");
    } else if (commandPolicy.effects.includes("workspace_read")) {
      filesystemIntent = mergeFilesystemIntent(filesystemIntent, "read");
    }
  }

  const networkTargets = collectCommandPolicyNetworkTargets(command);
  if (networkTargets.length > MAX_NETWORK_TARGETS) {
    addReason(unsupportedReasons, {
      code: "too_many_network_targets",
      detail: String(networkTargets.length),
    });
  }
  if (networkTargets.length > 0) {
    filesystemIntent = mergeFilesystemIntent(filesystemIntent, "unknown");
  }
  if (unsupportedReasons.some((reason) => reason.code === "write_redirection")) {
    filesystemIntent = mergeFilesystemIntent(filesystemIntent, "write");
  } else if (unsupportedReasons.some((reason) => reason.code === "input_redirection")) {
    filesystemIntent = mergeFilesystemIntent(filesystemIntent, "unknown");
  }

  const effects = new Set<CommandPolicyEffect>();
  for (const entry of commands) {
    for (const effect of entry.effects) {
      effects.add(effect);
    }
  }
  if (networkTargets.length > 0) {
    effects.add("external_network");
  }
  if (unsupportedReasons.length > 0) {
    effects.add("unsupported");
  }

  const dedupedReasons: CommandPolicyUnsupportedReason[] = [];
  for (const reason of unsupportedReasons) {
    addReason(dedupedReasons, reason);
  }
  const dedupedDiagnostics: CommandPolicyDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    addDiagnostic(dedupedDiagnostics, diagnostic);
  }

  const readonlyEligible =
    commands.length > 0 &&
    networkTargets.length === 0 &&
    dedupedReasons.length === 0 &&
    commands.every((entry) => entry.readonly);

  return {
    commands,
    effects: [...effects],
    networkTargets,
    filesystemIntent,
    unsupportedReasons: dedupedReasons,
    diagnostics: dedupedDiagnostics,
    readonlyEligible,
  };
}

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  return analyzeShellCommandInternal(command.trim(), 0);
}

export function summarizeShellCommandAnalysis(
  analysis: ShellCommandAnalysis,
): CommandPolicySummary {
  return {
    readonlyEligible: analysis.readonlyEligible,
    commands: uniqueStrings(analysis.commands.map((command) => command.name)),
    effects: [...analysis.effects],
    filesystemIntent: analysis.filesystemIntent,
    unsupportedReasons: analysis.unsupportedReasons.map((reason) => ({ ...reason })),
    diagnostics: analysis.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    networkTargets: analysis.networkTargets.map((target) => ({
      host: target.host,
      port: target.port,
      protocol: target.protocol,
    })),
  };
}
