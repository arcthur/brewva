import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayDaemon,
  SessionSupervisor,
  type GatewayDaemonTestConnectionInput,
  type OpenSessionInput,
  type OpenSessionResult,
  type SendPromptOptions,
  type SendPromptResult,
  type SessionBackend,
  type SessionWorkerInfo,
} from "@brewva/brewva-gateway";
import type { ContextStatusView } from "@brewva/brewva-runtime/session";
export { sleep } from "../../helpers/process.js";

export interface PolicyRule {
  id: string;
  intervalMinutes: number;
  prompt: string;
  sessionId?: string;
}

export interface ReloadPayload {
  sourcePath: string;
  loadedAt: number;
  rules: number;
  removedRules: number;
  closedSessions: number;
  removedRuleIds: string[];
  closedSessionIds: string[];
}

export interface SessionsClosePayload {
  sessionId: string;
  closed: boolean;
}

export function writeHeartbeatPolicy(policyPath: string, rules: PolicyRule[]): void {
  writeFileSync(
    policyPath,
    ["# HEARTBEAT", "", "```heartbeat", JSON.stringify({ rules }), "```", ""].join("\n"),
    "utf8",
  );
}

export function createDaemonHarness(
  initialRules: PolicyRule[],
  options: {
    sessionIdleTtlMs?: number;
    sessionIdleSweepIntervalMs?: number;
    sessionBackend?: SessionBackend;
    scheduleEnabled?: boolean;
  } = {},
): {
  root: string;
  policyPath: string;
  daemon: GatewayDaemon;
  dispose: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "brewva-gateway-daemon-"));
  const stateDir = join(root, "state");
  const policyPath = join(root, "HEARTBEAT.md");
  mkdirSync(join(root, ".brewva"), { recursive: true });
  if (options.scheduleEnabled === true) {
    writeFileSync(
      join(root, ".brewva", "brewva.json"),
      JSON.stringify(
        {
          schedule: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  writeHeartbeatPolicy(policyPath, initialRules);

  const daemon = new GatewayDaemon({
    host: "127.0.0.1",
    port: 0,
    stateDir,
    pidFilePath: join(stateDir, "gateway.pid.json"),
    logFilePath: join(stateDir, "gateway.log"),
    tokenFilePath: join(stateDir, "gateway.token"),
    heartbeatPolicyPath: policyPath,
    cwd: root,
    sessionIdleTtlMs: options.sessionIdleTtlMs,
    sessionIdleSweepIntervalMs: options.sessionIdleSweepIntervalMs,
    sessionBackend: options.sessionBackend,
  });

  return {
    root,
    policyPath,
    daemon,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function getHandleMethod(
  daemon: GatewayDaemon,
): (method: string, params: unknown, state?: GatewayDaemonTestConnectionInput) => Promise<unknown> {
  return async (method: string, params: unknown, state: GatewayDaemonTestConnectionInput = {}) => {
    return await daemon.testHooks.invokeMethod(
      method as Parameters<GatewayDaemon["testHooks"]["invokeMethod"]>[0],
      params,
      state,
    );
  };
}

export function getSupervisorForTest(daemon: GatewayDaemon): SessionSupervisor {
  const backend = daemon.testHooks.getSessionBackend();
  if (!(backend instanceof SessionSupervisor)) {
    throw new Error("daemon is not using SessionSupervisor");
  }
  return backend;
}

export function createConnectionState(connId = "conn-test"): {
  connId: string;
  subscribedSessions: Set<string>;
  phase: "authenticated";
} {
  return {
    connId,
    subscribedSessions: new Set<string>(),
    phase: "authenticated",
  };
}

export function createBroadcastSpy(daemon: GatewayDaemon): {
  events: Array<{ event: string; payload?: unknown }>;
  restore: () => void;
} {
  const events: Array<{ event: string; payload?: unknown }> = [];
  const restore = daemon.testHooks.observeBroadcasts((event, payload) => {
    events.push({ event, payload });
  });
  return { events, restore };
}

export function createSessionBackendStub(overrides: Partial<SessionBackend> = {}): SessionBackend {
  const base: SessionBackend = {
    start: async () => undefined,
    stop: async () => undefined,
    openSession: async (input: OpenSessionInput): Promise<OpenSessionResult> => ({
      sessionId: input.sessionId,
      created: true,
      workerPid: 4321,
    }),
    sendPrompt: async (
      sessionId: string,
      _prompt: string,
      _options?: SendPromptOptions,
    ): Promise<SendPromptResult> => ({
      sessionId,
      turnId: "turn-1",
      accepted: true,
    }),
    steerSession: async () => ({ status: "no_active_run" }),
    abortSession: async () => false,
    stopSession: async () => false,
    listWorkers: (): SessionWorkerInfo[] => [],
    querySessionWire: async () => [],
    querySessionContextStatus: async (): Promise<ContextStatusView | undefined> => undefined,
    querySessionLifecycle: async () => undefined,
  };
  return {
    ...base,
    ...overrides,
    steerSession:
      overrides.steerSession ?? ((sessionId, text) => base.steerSession(sessionId, text)),
  };
}
