import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SessionSupervisor } from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  buildWorkerTestHarnessEnv,
  WORKER_TEST_HARNESS_ENV_KEYS,
} from "../../../packages/brewva-gateway/src/session/worker-test-harness.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace, writeTestConfig } from "../../helpers/workspace.js";

const TEST_CONFIG_PATH = ".brewva/brewva.json";

async function waitForCondition<T>(
  check: () => T | null | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message: string;
  },
): Promise<T> {
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const intervalMs = Math.max(25, options.intervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
  }

  throw new Error(options.message);
}

async function sleepMs(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    timer.unref?.();
  });
}

function createWorkerTestEnv(overrides: {
  taskGoal: string;
  pollIntervalMs: number;
  thresholdMs: number;
}): Record<string, string | undefined> {
  return buildWorkerTestHarnessEnv({
    watchdog: {
      taskGoal: overrides.taskGoal,
      pollIntervalMs: overrides.pollIntervalMs,
      thresholdMs: overrides.thresholdMs,
    },
  });
}

function applyProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of WORKER_TEST_HARNESS_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = overrides[key];
    if (typeof value === "string") {
      process.env[key] = value;
      continue;
    }
    delete process.env[key];
  }

  return () => {
    for (const [key, value] of previous) {
      if (typeof value === "string") {
        process.env[key] = value;
        continue;
      }
      delete process.env[key];
    }
  };
}

describe("session supervisor watchdog bridge", () => {
  test("worker process persists watchdog detection and blocker state after init", async () => {
    const workspace = createTestWorkspace("supervisor-watchdog-worker-bridge");
    writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultConfigPath: TEST_CONFIG_PATH,
      defaultManagedToolMode: "direct",
      workerEnv: createWorkerTestEnv({
        taskGoal: "Detect stalled runtime work from the worker process",
        pollIntervalMs: 1_000,
        thresholdMs: 1_000,
      }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-bridge",
      });
      const agentSessionId = opened.agentSessionId;
      expect(agentSessionId).toEqual(expect.any(String));
      if (!agentSessionId) {
        throw new Error("expected worker bridge agent session id");
      }
      expect(agentSessionId.length).toBeGreaterThan(0);
      const resolvedAgentSessionId = agentSessionId;

      const detected = await waitForCondition(
        () => {
          if (!agentSessionId) return null;
          const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
          return observer.events.query(resolvedAgentSessionId, {
            type: "task_stuck_detected",
            last: 1,
          })[0];
        },
        {
          timeoutMs: 8_000,
          intervalMs: 100,
          message: "expected worker watchdog detection event",
        },
      );

      expect(detected.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 1_000,
        idleMs: expect.any(Number),
      });

      const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
      const taskState = observer.task.getState(resolvedAgentSessionId);
      expect(taskState.blockers).toEqual([]);
    } finally {
      await supervisor.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("stopSession shuts down worker before watchdog can emit stuck state", async () => {
    const workspace = createTestWorkspace("supervisor-watchdog-worker-stop");
    writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultConfigPath: TEST_CONFIG_PATH,
      defaultManagedToolMode: "direct",
      workerEnv: createWorkerTestEnv({
        taskGoal: "Ensure shutdown stops watchdog polling before detection",
        pollIntervalMs: 2_000,
        thresholdMs: 2_000,
      }),
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-stop",
      });
      const agentSessionId = opened.agentSessionId;
      expect(agentSessionId).toEqual(expect.any(String));
      if (!agentSessionId) {
        throw new Error("expected worker stop agent session id");
      }
      expect(agentSessionId.length).toBeGreaterThan(0);
      const resolvedAgentSessionId = agentSessionId;

      const stopped = await supervisor.stopSession("watchdog-worker-stop", "test_shutdown");
      expect(stopped).toBe(true);

      await sleepMs(3_000);

      const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
      expect(
        observer.events.query(resolvedAgentSessionId, {
          type: "task_stuck_detected",
        }),
      ).toHaveLength(0);

      const taskState = observer.task.getState(resolvedAgentSessionId);
      expect(taskState.blockers).toEqual([]);
    } finally {
      await supervisor.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("ambient watchdog env is ignored without explicit worker test overrides", async () => {
    const workspace = createTestWorkspace("supervisor-watchdog-worker-ambient-env");
    writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
    const restoreEnv = applyProcessEnv(
      buildWorkerTestHarnessEnv({
        enabled: false,
        watchdog: {
          taskGoal: "This ambient env should not bootstrap worker task state",
          pollIntervalMs: 1_000,
          thresholdMs: 1_000,
        },
      }),
    );

    const supervisor = new SessionSupervisor({
      stateDir: join(workspace, "state"),
      defaultCwd: workspace,
      defaultConfigPath: TEST_CONFIG_PATH,
      defaultManagedToolMode: "direct",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        log: () => {},
      },
    });

    try {
      const opened = await supervisor.openSession({
        sessionId: "watchdog-worker-ambient-env",
      });
      const agentSessionId = opened.agentSessionId;
      expect(typeof agentSessionId).toBe("string");
      expect(agentSessionId?.length).toBeGreaterThan(0);

      await sleepMs(1_500);

      const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
      expect(observer.events.query(agentSessionId!, { type: "task_stuck_detected" })).toHaveLength(
        0,
      );
      expect(observer.task.getState(agentSessionId!).spec).toBeUndefined();
    } finally {
      await supervisor.stop();
      restoreEnv();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
