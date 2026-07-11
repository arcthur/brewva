import { parseArgs as parseNodeArgs } from "node:util";
import { runEdgeOperation } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { runGatewayCliOperation } from "@brewva/brewva-gateway/admin";
import type { RuntimeResult } from "@brewva/brewva-runtime/core";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";

type CliValueResult<T> = RuntimeResult<{ value: T }>;

function okCliValue<T>(value: T): CliValueResult<T> {
  return { ok: true, value };
}

function cliValueError(error: string): CliValueResult<never> {
  return { ok: false, reason: error };
}

const ONBOARD_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  launchd: { type: "boolean" },
  systemd: { type: "boolean" },
  "install-daemon": { type: "boolean" },
  "uninstall-daemon": { type: "boolean" },
  "dry-run": { type: "boolean" },
  "no-start": { type: "boolean" },
  "managed-tools": { type: "string" },
  cwd: { type: "string" },
  config: { type: "string" },
  model: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "log-file": { type: "string" },
  "token-file": { type: "string" },
  heartbeat: { type: "string" },
  "tick-interval-ms": { type: "string" },
  "session-idle-ms": { type: "string" },
  "max-workers": { type: "string" },
  "max-open-queue": { type: "string" },
  "max-payload-bytes": { type: "string" },
  "health-http-port": { type: "string" },
  "health-http-path": { type: "string" },
  label: { type: "string" },
  "service-name": { type: "string" },
  "plist-file": { type: "string" },
  "unit-file": { type: "string" },
} as const;

function printOnboardHelp(): void {
  console.log(`Brewva onboarding helpers

Usage:
  brewva onboard --install-daemon [options]
  brewva onboard --uninstall-daemon [options]

Options:
  --install-daemon       Install gateway daemon service for current OS
  --uninstall-daemon     Remove previously installed daemon service
  --launchd              Force macOS launchd supervisor
  --systemd              Force Linux systemd user supervisor
  --dry-run              Print the generated supervisor file instead of writing it
  --json                 Emit machine-readable JSON output
  --no-start             Install the service but do not activate/start it
  --managed-tools <mode> Managed tool mode to persist (direct | hosted)
  --cwd <path>           Working directory for gateway start
  --config <path>        Config path forwarded to gateway start
  --model <route>        Default hosted model route
  --host <host>          Gateway listen host (loopback only)
  --port <port>          Gateway listen port
  --state-dir <path>     Gateway state directory
  --pid-file <path>      Gateway pid file path
  --log-file <path>      Gateway log file path
  --token-file <path>    Gateway token file path
  --heartbeat <path>     Heartbeat policy path
  --tick-interval-ms <n> Gateway scheduler tick interval
  --session-idle-ms <n>  Session idle timeout in milliseconds
  --max-workers <n>      Max worker processes
  --max-open-queue <n>   Max queued openSession requests
  --max-payload-bytes <n>
                        Max websocket payload size
  --health-http-port <port>
                        Optional health HTTP port
  --health-http-path <path>
                        Optional health HTTP path
  --label <label>        launchd label override
  --service-name <name>  systemd service name override
  --plist-file <path>    launchd file path override
  --unit-file <path>     systemd file path override

Examples:
  brewva onboard --install-daemon
  brewva onboard --install-daemon --systemd
  brewva onboard --install-daemon --dry-run --json
  brewva onboard --uninstall-daemon`);
}

function pushOnboardStringFlag(args: string[], name: string, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized) {
    return;
  }
  args.push(`--${name}`, normalized);
}

function pushOnboardBooleanFlag(args: string[], name: string, value: unknown): void {
  if (value === true) {
    args.push(`--${name}`);
  }
}

function resolveManagedToolModeFlag(raw: unknown): CliValueResult<ManagedToolMode> {
  if (raw === undefined) {
    return okCliValue("hosted");
  }
  if (raw === "direct" || raw === "hosted") {
    return okCliValue(raw);
  }
  return cliValueError("Error: invalid --managed-tools value. Use 'direct' or 'hosted'.");
}

export async function runOnboardCliOperation(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: ONBOARD_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printOnboardHelp();
    return 0;
  }
  if (parsed.positionals.length > 0) {
    console.error(`Error: unexpected positional args for onboard: ${parsed.positionals.join(" ")}`);
    return 1;
  }

  const installDaemon = parsed.values["install-daemon"] === true;
  const uninstallDaemon = parsed.values["uninstall-daemon"] === true;
  if (installDaemon && uninstallDaemon) {
    console.error("Error: --install-daemon and --uninstall-daemon cannot be used together.");
    return 1;
  }
  if (!installDaemon && !uninstallDaemon) {
    console.error("Error: onboard requires --install-daemon or --uninstall-daemon.");
    printOnboardHelp();
    return 1;
  }

  const gatewayArgs = [installDaemon ? "install" : "uninstall"];
  pushOnboardBooleanFlag(gatewayArgs, "json", parsed.values.json);
  pushOnboardBooleanFlag(gatewayArgs, "launchd", parsed.values.launchd);
  pushOnboardBooleanFlag(gatewayArgs, "systemd", parsed.values.systemd);
  pushOnboardBooleanFlag(gatewayArgs, "dry-run", parsed.values["dry-run"]);

  if (installDaemon) {
    pushOnboardBooleanFlag(gatewayArgs, "no-start", parsed.values["no-start"]);
    const managedToolMode = resolveManagedToolModeFlag(parsed.values["managed-tools"]);
    if (!managedToolMode.ok) {
      console.error(managedToolMode.reason);
      return 1;
    }
    pushOnboardStringFlag(gatewayArgs, "managed-tools", managedToolMode.value);

    pushOnboardStringFlag(gatewayArgs, "cwd", parsed.values.cwd);
    pushOnboardStringFlag(gatewayArgs, "config", parsed.values.config);
    pushOnboardStringFlag(gatewayArgs, "model", parsed.values.model);
    pushOnboardStringFlag(gatewayArgs, "host", parsed.values.host);
    pushOnboardStringFlag(gatewayArgs, "port", parsed.values.port);
    pushOnboardStringFlag(gatewayArgs, "state-dir", parsed.values["state-dir"]);
    pushOnboardStringFlag(gatewayArgs, "pid-file", parsed.values["pid-file"]);
    pushOnboardStringFlag(gatewayArgs, "log-file", parsed.values["log-file"]);
    pushOnboardStringFlag(gatewayArgs, "token-file", parsed.values["token-file"]);
    pushOnboardStringFlag(gatewayArgs, "heartbeat", parsed.values.heartbeat);
    pushOnboardStringFlag(gatewayArgs, "tick-interval-ms", parsed.values["tick-interval-ms"]);
    pushOnboardStringFlag(gatewayArgs, "session-idle-ms", parsed.values["session-idle-ms"]);
    pushOnboardStringFlag(gatewayArgs, "max-workers", parsed.values["max-workers"]);
    pushOnboardStringFlag(gatewayArgs, "max-open-queue", parsed.values["max-open-queue"]);
    pushOnboardStringFlag(gatewayArgs, "max-payload-bytes", parsed.values["max-payload-bytes"]);
    pushOnboardStringFlag(gatewayArgs, "health-http-port", parsed.values["health-http-port"]);
    pushOnboardStringFlag(gatewayArgs, "health-http-path", parsed.values["health-http-path"]);
  }

  pushOnboardStringFlag(gatewayArgs, "label", parsed.values.label);
  pushOnboardStringFlag(gatewayArgs, "service-name", parsed.values["service-name"]);
  pushOnboardStringFlag(gatewayArgs, "plist-file", parsed.values["plist-file"]);
  pushOnboardStringFlag(gatewayArgs, "unit-file", parsed.values["unit-file"]);

  const gatewayResult = await runGatewayCliOperation(gatewayArgs);
  return gatewayResult.exitCode;
}

export function runOnboardCliEffect(argv: string[]): BrewvaEffect.Effect<number, unknown> {
  return BrewvaEffect.promise(() => runOnboardCliOperation(argv));
}

export async function runOnboardCli(argv: string[]): Promise<number> {
  return runEdgeOperation("brewva.cli.onboard", runOnboardCliEffect(argv), {
    fields: {
      command: argv[0] ?? "help",
    },
  });
}
