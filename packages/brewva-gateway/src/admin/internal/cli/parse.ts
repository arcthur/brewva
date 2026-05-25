import type { RuntimeResult } from "@brewva/brewva-runtime/core";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";

export type GatewayCliValueResult<T> = RuntimeResult<{ value: T }>;

function okGatewayCliValue<T>(value: T): GatewayCliValueResult<T> {
  return { ok: true, value };
}

function gatewayCliValueError(error: string): GatewayCliValueResult<never> {
  return { ok: false, reason: error };
}

export function hasGatewayCliValue<T>(
  result: GatewayCliValueResult<T>,
): result is Extract<GatewayCliValueResult<T>, { ok: true }> {
  return result.ok;
}

export function printGatewayCliValueError<T>(result: GatewayCliValueResult<T>): void {
  if (!result.ok) {
    console.error(result.reason);
  }
}

export const START_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  detach: { type: "boolean" },
  foreground: { type: "boolean" },
  "wait-ms": { type: "string" },
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
  "managed-tools": { type: "string" },
  json: { type: "boolean" },
  "tick-interval-ms": { type: "string" },
  "session-idle-ms": { type: "string" },
  "max-workers": { type: "string" },
  "max-open-queue": { type: "string" },
  "max-payload-bytes": { type: "string" },
  "health-http-port": { type: "string" },
  "health-http-path": { type: "string" },
} as const;

export const STATUS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  deep: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const STOP_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  reason: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const HEARTBEAT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const SCHEDULER_PAUSE_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  reason: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const SCHEDULER_RESUME_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const ROTATE_TOKEN_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  host: { type: "string" },
  port: { type: "string" },
  "state-dir": { type: "string" },
  "pid-file": { type: "string" },
  "token-file": { type: "string" },
  "timeout-ms": { type: "string" },
} as const;

export const LOGS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  "state-dir": { type: "string" },
  "log-file": { type: "string" },
  tail: { type: "string" },
} as const;

export const INSTALL_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  launchd: { type: "boolean" },
  systemd: { type: "boolean" },
  "no-start": { type: "boolean" },
  "dry-run": { type: "boolean" },
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
  "managed-tools": { type: "string" },
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

export const UNINSTALL_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  launchd: { type: "boolean" },
  systemd: { type: "boolean" },
  "dry-run": { type: "boolean" },
  label: { type: "string" },
  "service-name": { type: "string" },
  "plist-file": { type: "string" },
  "unit-file": { type: "string" },
} as const;

export function parseOptionalIntegerFlag(
  flag: string,
  raw: unknown,
  options: {
    minimum?: number;
    maximum?: number;
  } = {},
): GatewayCliValueResult<number | undefined> {
  if (typeof raw !== "string") {
    return okGatewayCliValue(undefined);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return gatewayCliValueError(`Error: --${flag} must be an integer.`);
  }

  const value = Number(trimmed);
  if (!Number.isInteger(value)) {
    return gatewayCliValueError(`Error: --${flag} must be an integer.`);
  }
  if (options.minimum !== undefined && value < options.minimum) {
    return gatewayCliValueError(`Error: --${flag} must be >= ${options.minimum}.`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    return gatewayCliValueError(`Error: --${flag} must be <= ${options.maximum}.`);
  }
  return okGatewayCliValue(value);
}

export function pushStringFlag(args: string[], name: string, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (!normalized) {
    return;
  }
  args.push(`--${name}`, normalized);
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

export function resolveManagedToolModeFlag(raw: unknown): GatewayCliValueResult<ManagedToolMode> {
  if (raw === undefined) {
    return okGatewayCliValue("hosted");
  }
  if (raw === "hosted" || raw === "direct") {
    return okGatewayCliValue(raw);
  }
  return gatewayCliValueError(
    `Error: --managed-tools must be "hosted" or "direct" (received "${describeFlagValue(raw)}").`,
  );
}

export function parseOptionalPathFlag(
  flag: string,
  raw: unknown,
): GatewayCliValueResult<string | undefined> {
  if (typeof raw !== "string") {
    return okGatewayCliValue(undefined);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return gatewayCliValueError(`Error: --${flag} must be a non-empty path.`);
  }
  return okGatewayCliValue(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
}
