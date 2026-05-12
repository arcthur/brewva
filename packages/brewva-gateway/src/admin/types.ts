import type { GatewayPidRecord } from "../daemon/api.js";

export interface GatewayPaths {
  stateDir: string;
  pidFilePath: string;
  logFilePath: string;
  tokenFilePath: string;
  heartbeatPolicyPath: string;
}

export interface GatewayStatusReport {
  running: boolean;
  reachable: boolean;
  stalePid: boolean;
  pidRecord?: GatewayPidRecord;
  host?: string;
  port?: number;
  health?: unknown;
  deep?: unknown;
  error?: string;
}

export interface RunGatewayCliOptions {
  allowUnknownCommandFallback?: boolean;
}

export interface RunGatewayCliResult {
  handled: boolean;
  exitCode: number;
}

export type GatewayAdminCommand =
  | { kind: "help" }
  | { kind: "start"; argv: string[] }
  | { kind: "install"; argv: string[] }
  | { kind: "uninstall"; argv: string[] }
  | { kind: "status"; argv: string[] }
  | { kind: "stop"; argv: string[] }
  | { kind: "scheduler-pause"; argv: string[] }
  | { kind: "scheduler-resume"; argv: string[] }
  | { kind: "heartbeat-reload"; argv: string[] }
  | { kind: "rotate-token"; argv: string[] }
  | { kind: "logs"; argv: string[] }
  | { kind: "unknown"; command: string; argv: string[] };

export interface GatewayAdminPort {
  resolveGatewayPaths(input: {
    cwd?: string;
    stateDir?: string;
    pidFile?: string;
    logFile?: string;
    tokenFile?: string;
    heartbeat?: string;
  }): GatewayPaths;
  queryGatewayStatus(input: {
    cwd?: string;
    host?: string;
    port?: number;
    stateDir?: string;
    pidFile?: string;
    tokenFile?: string;
    timeoutMs?: number;
    includeDeep?: boolean;
  }): Promise<GatewayStatusReport>;
  runGatewayCliOperation(
    argv: string[],
    options?: RunGatewayCliOptions,
  ): Promise<RunGatewayCliResult>;
  runGatewayCli(argv: string[], options?: RunGatewayCliOptions): Promise<RunGatewayCliResult>;
}
