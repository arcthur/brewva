import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayDaemon } from "@brewva/brewva-gateway";
import { patchProcessEnv } from "./global-state.js";

export type GatewayWorkerHarnessConfig = {
  enabled?: boolean;
  watchdog?: {
    taskGoal?: string;
    pollIntervalMs?: number;
    thresholdMs?: number;
  };
  fakeAssistantText?: string;
};

function normalizePositiveInteger(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return String(Math.floor(value));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildGatewayWorkerHarnessEnv(
  config: GatewayWorkerHarnessConfig,
): Record<string, string | undefined> {
  const fakeAssistantText = normalizeOptionalString(config.fakeAssistantText);
  const taskGoal = normalizeOptionalString(config.watchdog?.taskGoal);
  const pollIntervalMs = normalizePositiveInteger(config.watchdog?.pollIntervalMs);
  const thresholdMs = normalizePositiveInteger(config.watchdog?.thresholdMs);
  const hasOverrides = fakeAssistantText || taskGoal || pollIntervalMs || thresholdMs;
  const enabled = config.enabled ?? Boolean(hasOverrides);

  return {
    BREWVA_INTERNAL_GATEWAY_TEST_OVERRIDES: enabled ? "1" : undefined,
    BREWVA_INTERNAL_GATEWAY_FAKE_ASSISTANT_TEXT: fakeAssistantText,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_TASK_GOAL: taskGoal,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_POLL_MS: pollIntervalMs,
    BREWVA_INTERNAL_GATEWAY_WATCHDOG_THRESHOLD_MS: thresholdMs,
  };
}

export interface GatewayDaemonHarness {
  root: string;
  stateDir: string;
  daemon: GatewayDaemon;
  env: Record<string, string>;
  dispose(): Promise<void>;
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close(() => rejectPort(new Error("failed to allocate local port")));
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(port);
      });
    });
    probe.unref();
  });
}

export async function startGatewayDaemonHarness(input: {
  workspace: string;
  fakeAssistantText?: string;
}): Promise<GatewayDaemonHarness> {
  const root = mkdtempSync(join(tmpdir(), "brewva-system-gateway-"));
  const stateDir = join(root, "state");
  const policyPath = join(root, "HEARTBEAT.md");
  writeFileSync(
    policyPath,
    ["# HEARTBEAT", "", "```heartbeat", '{"rules":[]}', "```", ""].join("\n"),
  );

  const port = await allocatePort();
  const daemon = new GatewayDaemon({
    host: "127.0.0.1",
    port,
    stateDir,
    pidFilePath: join(stateDir, "gateway.pid.json"),
    logFilePath: join(stateDir, "gateway.log"),
    tokenFilePath: join(stateDir, "gateway.token"),
    heartbeatPolicyPath: policyPath,
    cwd: input.workspace,
  });

  const env = buildGatewayWorkerHarnessEnv({
    fakeAssistantText: input.fakeAssistantText,
  });
  const restoreEnv = patchProcessEnv(env);

  await daemon.start();
  const runtime = daemon.getRuntimeInfo();

  return {
    root,
    stateDir,
    daemon,
    env: {
      BREWVA_GATEWAY_STATE_DIR: stateDir,
      BREWVA_GATEWAY_HOST: runtime.host,
      BREWVA_GATEWAY_PORT: String(runtime.port),
    },
    dispose: async () => {
      await daemon.stop("test_dispose").catch(() => undefined);
      await daemon.waitForStop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
      restoreEnv();
    },
  };
}
