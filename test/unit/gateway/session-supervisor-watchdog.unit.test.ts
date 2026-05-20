import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionSupervisor } from "@brewva/brewva-gateway";
import { TASK_STUCK_DETECTED_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import {
  listGatewaySessionBindings,
  resolveGatewaySessionBindingStorePath,
} from "../../../packages/brewva-gateway/src/daemon/session-supervisor/session-binding-store.js";
import {
  buildWorkerTestHarnessEnv,
  WORKER_TEST_HARNESS_ENV_KEYS,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/worker/test-harness.js";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import { patchProcessEnv } from "../../helpers/global-state.js";
import { sleep } from "../../helpers/process.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
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
    await sleep(intervalMs);
  }

  throw new Error(options.message);
}

async function sleepMs(durationMs: number): Promise<void> {
  await sleep(durationMs);
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
        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });

        const detected = await waitForCondition(
          () =>
            observer.ops.events.records.query(resolvedAgentSessionId, {
              type: TASK_STUCK_DETECTED_EVENT_TYPE,
              last: 1,
            })[0],
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

        const taskState = observer.ops.task.state.get(resolvedAgentSessionId);
        expect(taskState.blockers).toEqual([]);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
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
        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });

        const stopped = await supervisor.stopSession("watchdog-worker-stop", "test_shutdown");
        expect(stopped).toBe(true);

        const shutdown = await waitForCondition(
          () =>
            observer.ops.events.records.query(resolvedAgentSessionId, {
              type: "session_shutdown",
              last: 1,
            })[0],
          {
            timeoutMs: 5_000,
            intervalMs: 100,
            message: "expected structured session_shutdown after explicit stop",
          },
        );

        expect(shutdown.payload).toMatchObject({
          reason: "test_shutdown",
          source: "session_worker_shutdown",
        });

        await sleepMs(3_000);

        expect(
          observer.ops.events.records.query(resolvedAgentSessionId, {
            type: "task_stuck_detected",
          }),
        ).toHaveLength(0);

        const taskState = observer.ops.task.state.get(resolvedAgentSessionId);
        expect(taskState.blockers).toEqual([]);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
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

        const bindingReceipts = listGatewaySessionBindings(
          resolveGatewaySessionBindingStorePath(stateDir),
          "archived-session",
        );
        expect(bindingReceipts).toHaveLength(2);
        expect(bindingReceipts).toMatchObject([
          {
            gatewaySessionId: "archived-session",
            agentSessionId: firstOpen.agentSessionId,
          },
          {
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
    "supervisor does not synthesize child tape truth after worker hard exit",
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

        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });
        expect(
          observer.ops.events.records.query(agentSessionId, {
            type: "session_shutdown",
          }),
        ).toHaveLength(0);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 12_000 },
  );

  test(
    "startup orphan sweep drops stale registry rows without writing child tape truth",
    async () => {
      const workspace = createTestWorkspace("supervisor-registry-recovery");
      const runtimeConfig = createOpsRuntimeConfig();
      writeTestConfig(workspace, runtimeConfig, TEST_CONFIG_PATH);
      const stateDir = join(workspace, "state");
      const agentSessionId = "agent-registry-stale";
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

        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });
        expect(
          observer.ops.events.records.query(agentSessionId, {
            type: "session_shutdown",
          }),
        ).toHaveLength(0);
      } finally {
        await supervisor.stop();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 8_000 },
  );

  test(
    "startup orphan sweep ignores stale registry rows without an agent runtime writer",
    async () => {
      const workspace = createTestWorkspace("supervisor-registry-missing-event-log");
      writeTestConfig(workspace, createOpsRuntimeConfig(), TEST_CONFIG_PATH);
      const stateDir = join(workspace, "state");
      const agentSessionId = "agent-registry-missing-event-log";
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
          warn: () => {},
          error: () => {},
          log: () => {},
        },
      });

      try {
        await supervisor.start();
        await sleepMs(200);

        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });
        expect(
          observer.ops.events.records.query(agentSessionId, {
            type: "session_shutdown",
          }),
        ).toHaveLength(0);
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
        const agentSessionId = requireNonEmptyString(
          opened.agentSessionId,
          "expected worker ambient env agent session id",
        );

        await sleepMs(1_500);

        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: TEST_CONFIG_PATH,
        });
        expect(
          observer.ops.events.records.query(agentSessionId, { type: "task_stuck_detected" }),
        ).toHaveLength(0);
        expect(observer.ops.task.state.get(agentSessionId).spec).toBe(undefined);
      } finally {
        await supervisor.stop();
        restoreEnv();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    { timeout: 10_000 },
  );
});
