import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type GatewaySupervisorKind = "launchd" | "systemd";

export interface GatewayInstallServiceOptions {
  kind: GatewaySupervisorKind;
  programArguments: string[];
  workingDirectory: string;
  logFilePath: string;
  pathEnv?: string;
  label?: string;
  serviceName?: string;
  plistFilePath?: string;
  unitFilePath?: string;
  noStart?: boolean;
  dryRun?: boolean;
}

export interface GatewayUninstallServiceOptions {
  kind: GatewaySupervisorKind;
  label?: string;
  serviceName?: string;
  plistFilePath?: string;
  unitFilePath?: string;
  dryRun?: boolean;
}

export interface ServiceCommandResult {
  command: string;
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface GatewayInstallServiceResult {
  kind: GatewaySupervisorKind;
  filePath: string;
  labelOrService: string;
  written: boolean;
  activated: boolean;
  content: string;
  commands: ServiceCommandResult[];
}

export interface GatewayUninstallServiceResult {
  kind: GatewaySupervisorKind;
  filePath: string;
  labelOrService: string;
  removed: boolean;
  commands: ServiceCommandResult[];
}

const DEFAULT_LAUNCHD_LABEL = "com.brewva.gateway";
const DEFAULT_SYSTEMD_SERVICE_NAME = "brewva-gateway";

export const GatewaySupervisorDefaults = {
  launchdLabel: DEFAULT_LAUNCHD_LABEL,
  systemdServiceName: DEFAULT_SYSTEMD_SERVICE_NAME,
} as const;

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function formatCommand(parts: string[]): string {
  return parts.map((part) => shellQuote(part)).join(" ");
}

function runCommand(parts: string[]): ServiceCommandResult {
  const [command, ...args] = parts;
  if (!command) {
    return {
      command: "",
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error: "missing command",
    };
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
  });

  return {
    command: formatCommand(parts),
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    error: result.error ? result.error.message : undefined,
  };
}

function ensureCommandSuccess(result: ServiceCommandResult, action: string): void {
  if (result.ok) {
    return;
  }
  const details = [
    `command=${result.command}`,
    `status=${String(result.status)}`,
    result.error ? `error=${result.error}` : "",
    result.stderr ? `stderr=${result.stderr}` : "",
    result.stdout ? `stdout=${result.stdout}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("; ");
  throw new Error(`${action} failed (${details})`);
}

function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function writeFileIfChanged(filePath: string, content: string): boolean {
  const resolvedPath = resolve(filePath);
  if (existsSync(resolvedPath)) {
    const current = readFileSync(resolvedPath, "utf8");
    if (current === content) {
      return false;
    }
  }
  writeFileSync(resolvedPath, content, "utf8");
  return true;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdEscapeArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeLaunchdLabel(label?: string): string {
  const normalized = label?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_LAUNCHD_LABEL;
}

function normalizeSystemdServiceName(serviceName?: string): string {
  const normalized = serviceName?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_SYSTEMD_SERVICE_NAME;
}

function resolveLaunchdPlistPath(label: string, explicitPath?: string): string {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return resolve(explicitPath);
  }
  return resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function resolveSystemdUnitPath(serviceName: string, explicitPath?: string): string {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return resolve(explicitPath);
  }
  return resolve(homedir(), ".config", "systemd", "user", `${serviceName}.service`);
}

function renderLaunchdPlist(input: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  logFilePath: string;
  pathEnv: string;
}): string {
  const programArguments = input.programArguments
    .map((arg) => `      <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(input.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(input.workingDirectory)}</string>`,
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(input.logFilePath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(input.logFilePath)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${xmlEscape(input.pathEnv)}</string>`,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderSystemdUnit(input: {
  programArguments: string[];
  workingDirectory: string;
  pathEnv: string;
}): string {
  const execStart = input.programArguments.map((arg) => systemdEscapeArg(arg)).join(" ");

  return [
    "[Unit]",
    "Description=Brewva Gateway Control Plane",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdEscapeArg(input.workingDirectory)}`,
    `Environment=PATH=${systemdEscapeArg(input.pathEnv)}`,
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=2",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function installGatewayService(
  options: GatewayInstallServiceOptions,
): GatewayInstallServiceResult {
  if (options.programArguments.length === 0) {
    throw new Error("gateway service program arguments are required");
  }

  const commands: ServiceCommandResult[] = [];
  const pathEnv = options.pathEnv?.trim() || process.env.PATH || "";
  const workingDirectory = resolve(options.workingDirectory);

  if (options.kind === "launchd") {
    const label = normalizeLaunchdLabel(options.label);
    const filePath = resolveLaunchdPlistPath(label, options.plistFilePath);
    const content = renderLaunchdPlist({
      label,
      programArguments: options.programArguments,
      workingDirectory,
      logFilePath: resolve(options.logFilePath),
      pathEnv,
    });

    let written = false;
    if (!options.dryRun) {
      ensureParentDirectory(filePath);
      written = writeFileIfChanged(filePath, content);

      if (!options.noStart) {
        commands.push(runCommand(["launchctl", "unload", "-w", filePath]));
        const loadResult = runCommand(["launchctl", "load", "-w", filePath]);
        commands.push(loadResult);
        ensureCommandSuccess(loadResult, "launchd load");
      }
    }

    return {
      kind: options.kind,
      filePath,
      labelOrService: label,
      written,
      activated: options.noStart !== true,
      content,
      commands,
    };
  }

  const serviceName = normalizeSystemdServiceName(options.serviceName);
  const filePath = resolveSystemdUnitPath(serviceName, options.unitFilePath);
  const content = renderSystemdUnit({
    programArguments: options.programArguments,
    workingDirectory,
    pathEnv,
  });

  let written = false;
  if (!options.dryRun) {
    ensureParentDirectory(filePath);
    written = writeFileIfChanged(filePath, content);

    if (!options.noStart) {
      const daemonReload = runCommand(["systemctl", "--user", "daemon-reload"]);
      commands.push(daemonReload);
      ensureCommandSuccess(daemonReload, "systemd daemon-reload");

      const enableNow = runCommand([
        "systemctl",
        "--user",
        "enable",
        "--now",
        `${serviceName}.service`,
      ]);
      commands.push(enableNow);
      ensureCommandSuccess(enableNow, "systemd enable --now");
    }
  }

  return {
    kind: options.kind,
    filePath,
    labelOrService: `${serviceName}.service`,
    written,
    activated: options.noStart !== true,
    content,
    commands,
  };
}

export function uninstallGatewayService(
  options: GatewayUninstallServiceOptions,
): GatewayUninstallServiceResult {
  const commands: ServiceCommandResult[] = [];

  if (options.kind === "launchd") {
    const label = normalizeLaunchdLabel(options.label);
    const filePath = resolveLaunchdPlistPath(label, options.plistFilePath);

    if (!options.dryRun) {
      commands.push(runCommand(["launchctl", "unload", "-w", filePath]));
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    }

    return {
      kind: options.kind,
      filePath,
      labelOrService: label,
      removed: options.dryRun ? false : !existsSync(filePath),
      commands,
    };
  }

  const serviceName = normalizeSystemdServiceName(options.serviceName);
  const filePath = resolveSystemdUnitPath(serviceName, options.unitFilePath);

  if (!options.dryRun) {
    commands.push(
      runCommand(["systemctl", "--user", "disable", "--now", `${serviceName}.service`]),
    );
    commands.push(runCommand(["systemctl", "--user", "daemon-reload"]));
    commands.push(runCommand(["systemctl", "--user", "reset-failed", `${serviceName}.service`]));
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }

  return {
    kind: options.kind,
    filePath,
    labelOrService: `${serviceName}.service`,
    removed: options.dryRun ? false : !existsSync(filePath),
    commands,
  };
}

export function resolveSupervisorKind(input: {
  launchd: boolean;
  systemd: boolean;
  platform: NodeJS.Platform;
}): { kind?: GatewaySupervisorKind; error?: string } {
  if (input.launchd && input.systemd) {
    return {
      error: "Error: --launchd and --systemd cannot be used together.",
    };
  }

  if (input.launchd) {
    if (input.platform !== "darwin") {
      return {
        error: "Error: --launchd is only supported on macOS.",
      };
    }
    return { kind: "launchd" };
  }

  if (input.systemd) {
    if (input.platform !== "linux") {
      return {
        error: "Error: --systemd is only supported on Linux.",
      };
    }
    return { kind: "systemd" };
  }

  if (input.platform === "darwin") {
    return { kind: "launchd" };
  }
  if (input.platform === "linux") {
    return { kind: "systemd" };
  }

  return {
    error:
      "Error: unsupported platform for gateway supervisor install. Use macOS (launchd) or Linux (systemd).",
  };
}

export function buildGatewaySupervisorCommand(input: {
  startArgs: string[];
  bootstrapPrefix: string[];
  entryArg?: string;
}): string[] {
  const startArgs = input.startArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  if (startArgs.length === 0) {
    throw new Error("gateway start arguments are required");
  }

  if (input.bootstrapPrefix.length > 0) {
    return [process.execPath, ...input.bootstrapPrefix, ...startArgs];
  }

  if (typeof input.entryArg === "string" && input.entryArg.trim()) {
    const resolvedEntry = resolve(input.entryArg);
    const normalizedEntry = resolvedEntry.replaceAll("\\", "/");
    const isBunVirtualPath = normalizedEntry.includes("/$bunfs/");
    if (existsSync(resolvedEntry) && !isBunVirtualPath) {
      return [resolvedEntry, ...startArgs];
    }
  }

  return ["/usr/bin/env", "brewva", ...startArgs];
}
