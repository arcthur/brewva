import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionSupervisor } from "@brewva/brewva-gateway";
import { BrewvaRuntime, GATEWAY_SESSION_BOUND_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  readBrewvaEventRecordsFromLogPath,
  resolveBrewvaEventLogPath,
} from "@brewva/brewva-runtime/internal";
import {
  GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID,
  resolveGatewaySessionBindingLogPath,
} from "../../../packages/brewva-gateway/src/daemon/session-binding-tape.js";
import {
  buildWorkerTestHarnessEnv,
  WORKER_TEST_HARNESS_ENV_KEYS,
} from "../../../packages/brewva-gateway/src/session/worker-test-harness.js";
import { patchProcessEnv } from "../../helpers/global-state.js";
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

describe("session supervisor watchdog bridge", () => {
  test(
    "worker process persists watchdog detection and blocker state after init",
    async () => {
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
            return observer.inspect.events.query(resolvedAgentSessionId, {
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
        const taskState = observer.inspect.task.getState(resolvedAgentSessionId);
        expect(taskState.blockers).toEqual([]);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );

  test(
    "stopSession shuts down worker before watchdog can emit stuck state",
    async () => {
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
          observer.inspect.events.query(resolvedAgentSessionId, {
            type: "task_stuck_detected",
          }),
        ).toHaveLength(0);

        const taskState = observer.inspect.task.getState(resolvedAgentSessionId);
        expect(taskState.blockers).toEqual([]);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );

  test(
    "querySessionWire replays archived frames across multiple worker segments for the same public session id",
    async () => {
      const workspace = createTestWorkspace("supervisor-session-wire-archived-replay");
      const stateDir = join(workspace, "state");
      writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
      let supervisor: SessionSupervisor | null = new SessionSupervisor({
        stateDir,
        defaultCwd: workspace,
        defaultConfigPath: TEST_CONFIG_PATH,
        defaultManagedToolMode: "direct",
        workerEnv: buildWorkerTestHarnessEnv({
          fakeAssistantText: "ARCHIVED_SESSION_WIRE_OK",
        }),
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          log: () => {},
        },
      });
      let replaySupervisor: SessionSupervisor | null = null;

      try {
        const firstOpen = await supervisor.openSession({
          sessionId: "archived-session",
        });
        expect(firstOpen.agentSessionId).toEqual(expect.any(String));

        await supervisor.sendPrompt("archived-session", "first prompt", {
          turnId: "turn-1",
          waitForCompletion: true,
        });
        expect(await supervisor.stopSession("archived-session", "segment_one_closed")).toBe(true);

        const secondOpen = await supervisor.openSession({
          sessionId: "archived-session",
        });
        expect(secondOpen.agentSessionId).toEqual(expect.any(String));
        expect(secondOpen.agentSessionId).not.toBe(firstOpen.agentSessionId);

        await supervisor.sendPrompt("archived-session", "second prompt", {
          turnId: "turn-2",
          waitForCompletion: true,
        });
        expect(await supervisor.stopSession("archived-session", "segment_two_closed")).toBe(true);

        writeFileSync(join(stateDir, "sessions.json"), "{ invalid_legacy_binding_state", "utf8");

        await supervisor.stop();
        replaySupervisor = new SessionSupervisor({
          stateDir,
          defaultCwd: workspace,
          defaultConfigPath: TEST_CONFIG_PATH,
          defaultManagedToolMode: "direct",
          workerEnv: buildWorkerTestHarnessEnv({
            fakeAssistantText: "ARCHIVED_SESSION_WIRE_OK",
          }),
          logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            log: () => {},
          },
        });
        await replaySupervisor.start();
        supervisor = null;

        let frames = await replaySupervisor.querySessionWire("archived-session");
        const deadline = Date.now() + 5_000;
        while (
          Date.now() < deadline &&
          frames.filter((frame) => frame.type === "session.closed").length < 2
        ) {
          await sleepMs(50);
          frames = await replaySupervisor.querySessionWire("archived-session");
        }

        expect(frames.filter((frame) => frame.type === "turn.input")).toMatchObject([
          {
            type: "turn.input",
            turnId: "turn-1",
            promptText: "first prompt",
          },
          {
            type: "turn.input",
            turnId: "turn-2",
            promptText: "second prompt",
          },
        ]);
        expect(frames.filter((frame) => frame.type === "turn.committed")).toMatchObject([
          {
            type: "turn.committed",
            turnId: "turn-1",
            assistantText: "ARCHIVED_SESSION_WIRE_OK",
          },
          {
            type: "turn.committed",
            turnId: "turn-2",
            assistantText: "ARCHIVED_SESSION_WIRE_OK",
          },
        ]);
        expect(
          frames.filter((frame) => frame.type === "session.closed").length,
        ).toBeGreaterThanOrEqual(2);

        const bindingEvents = readBrewvaEventRecordsFromLogPath(
          resolveGatewaySessionBindingLogPath(stateDir),
          {
            sessionId: GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID,
          },
        ).filter((event) => event.type === GATEWAY_SESSION_BOUND_EVENT_TYPE);
        expect(bindingEvents).toHaveLength(2);
        expect(bindingEvents.map((event) => event.payload)).toMatchObject([
          {
            schema: "brewva.gateway-session-binding.v1",
            gatewaySessionId: "archived-session",
            agentSessionId: firstOpen.agentSessionId,
          },
          {
            schema: "brewva.gateway-session-binding.v1",
            gatewaySessionId: "archived-session",
            agentSessionId: secondOpen.agentSessionId,
          },
        ]);
      } finally {
        await replaySupervisor?.stop();
        await supervisor?.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );

  test(
    "supervisor synthesizes a terminal receipt after worker hard exit",
    async () => {
      const workspace = createTestWorkspace("supervisor-worker-hard-exit");
      writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
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
          sessionId: "worker-hard-exit",
        });
        const agentSessionId = opened.agentSessionId;
        expect(agentSessionId).toEqual(expect.any(String));
        if (!agentSessionId) {
          throw new Error("expected agent session id for hard exit test");
        }

        process.kill(opened.workerPid, "SIGKILL");

        await waitForCondition(
          () =>
            supervisor.listWorkers().some((worker) => worker.sessionId === "worker-hard-exit")
              ? null
              : true,
          {
            timeoutMs: 5_000,
            intervalMs: 50,
            message: "expected supervisor to observe worker exit",
          },
        );

        const shutdown = await waitForCondition(
          () => {
            const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
            return observer.inspect.events.query(agentSessionId, {
              type: "session_shutdown",
              last: 1,
            })[0];
          },
          {
            timeoutMs: 8_000,
            intervalMs: 100,
            message: "expected synthesized session_shutdown after hard exit",
          },
        );

        expect(shutdown.payload).toMatchObject({
          reason: "abnormal_process_exit",
          source: "session_supervisor_worker_exit",
          signal: "SIGKILL",
          workerSessionId: "worker-hard-exit",
          recoveredFromRegistry: false,
        });
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 12_000 },
  );

  test(
    "startup orphan sweep synthesizes a terminal receipt from the persisted event log path",
    async () => {
      const workspace = createTestWorkspace("supervisor-registry-recovery");
      const runtimeConfig = createOpsRuntimeConfig();
      writeTestConfig(workspace, runtimeConfig, TEST_CONFIG_PATH);
      const stateDir = join(workspace, "state");
      const agentSessionId = "agent-registry-stale";
      const agentEventLogPath = resolveBrewvaEventLogPath(
        join(workspace, runtimeConfig.infrastructure.events.dir),
        agentSessionId,
      );
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "children.json"),
        JSON.stringify(
          [
            {
              sessionId: "worker-registry-stale",
              pid: 999999,
              startedAt: Date.now() - 10_000,
              agentSessionId,
              agentEventLogPath,
              cwd: workspace,
            },
          ],
          null,
          2,
        ),
        "utf8",
      );

      const supervisor = new SessionSupervisor({
        stateDir,
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
        await supervisor.start();

        const shutdown = await waitForCondition(
          () => {
            const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
            return observer.inspect.events.query(agentSessionId, {
              type: "session_shutdown",
              last: 1,
            })[0];
          },
          {
            timeoutMs: 5_000,
            intervalMs: 100,
            message: "expected synthesized session_shutdown from registry recovery",
          },
        );

        expect(shutdown.payload).toMatchObject({
          reason: "abnormal_process_exit",
          source: "session_supervisor_registry_recovery",
          workerSessionId: "worker-registry-stale",
          recoveredFromRegistry: true,
        });
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 8_000 },
  );

  test(
    "startup orphan sweep does not synthesize a terminal receipt without a persisted event log path",
    async () => {
      const workspace = createTestWorkspace("supervisor-registry-missing-event-log");
      writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
      const stateDir = join(workspace, "state");
      const agentSessionId = "agent-registry-missing-event-log";
      const warns: Array<{ message: string; meta: unknown }> = [];
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "children.json"),
        JSON.stringify(
          [
            {
              sessionId: "worker-registry-missing-event-log",
              pid: 999999,
              startedAt: Date.now() - 10_000,
              agentSessionId,
              cwd: workspace,
            },
          ],
          null,
          2,
        ),
        "utf8",
      );

      const supervisor = new SessionSupervisor({
        stateDir,
        defaultCwd: workspace,
        defaultConfigPath: TEST_CONFIG_PATH,
        defaultManagedToolMode: "direct",
        logger: {
          debug: () => {},
          info: () => {},
          warn: (message, meta) => warns.push({ message, meta }),
          error: () => {},
          log: () => {},
        },
      });

      try {
        await supervisor.start();
        await sleepMs(200);

        const observer = new BrewvaRuntime({ cwd: workspace, configPath: TEST_CONFIG_PATH });
        expect(
          observer.inspect.events.query(agentSessionId, {
            type: "session_shutdown",
          }),
        ).toHaveLength(0);
        expect(warns).toContainEqual({
          message: "cannot synthesize session terminal receipt without agent event log path",
          meta: {
            sessionId: "worker-registry-missing-event-log",
            agentSessionId,
            source: "session_supervisor_registry_recovery",
          },
        });
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 8_000 },
  );

  test(
    "ambient watchdog env is ignored without explicit worker test overrides",
    async () => {
      const workspace = createTestWorkspace("supervisor-watchdog-worker-ambient-env");
      writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
      const envOverrides = buildWorkerTestHarnessEnv({
        enabled: false,
        watchdog: {
          taskGoal: "This ambient env should not bootstrap worker task state",
          pollIntervalMs: 1_000,
          thresholdMs: 1_000,
        },
      });
      const restoreEnv = patchProcessEnv(
        Object.fromEntries(
          WORKER_TEST_HARNESS_ENV_KEYS.map((key) => [key, envOverrides[key]]),
        ) as Record<string, string | undefined>,
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
        expect(
          observer.inspect.events.query(agentSessionId!, { type: "task_stuck_detected" }),
        ).toHaveLength(0);
        expect(observer.inspect.task.getState(agentSessionId!).spec).toBeUndefined();
      } finally {
        await supervisor.stop();
        restoreEnv();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );
});
