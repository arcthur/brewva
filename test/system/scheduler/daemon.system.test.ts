import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { asBrewvaIntentId, asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import { parseScheduleIntentEvent } from "@brewva/brewva-runtime/protocol";
import { writeMinimalConfig } from "../../helpers/config.js";
import { buildGatewayWorkerHarnessEnv, startGatewayDaemonHarness } from "../../helpers/gateway.js";
import { sleep, withTimeout } from "../../helpers/process.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { cleanupWorkspace, createWorkspace, repoRoot } from "../../helpers/workspace.js";

interface DaemonProcess {
  child: ChildProcess;
  readStdout(): string;
  readStderr(): string;
}

const SCHEDULER_DAEMON_WAIT_TIMEOUT_MS = 20_000;
const SCHEDULER_DAEMON_TEST_TIMEOUT_MS = 30_000;

async function waitForCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    message: string;
    daemon?: DaemonProcess;
  },
): Promise<T> {
  const timeoutMs = Math.max(500, options.timeoutMs ?? 12_000);
  const intervalMs = Math.max(50, options.intervalMs ?? 150);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }

    const exitCode = options.daemon?.child.exitCode;
    if (exitCode !== null && exitCode !== undefined) {
      const stderr = options.daemon?.readStderr() ?? "";
      const stdout = options.daemon?.readStdout() ?? "";
      throw new Error(
        [
          options.message,
          `daemon exited early with code ${exitCode}`,
          stderr ? `stderr:\n${stderr}` : "",
          stdout ? `stdout:\n${stdout}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    await sleep(intervalMs);
  }

  const stderr = options.daemon?.readStderr() ?? "";
  const stdout = options.daemon?.readStdout() ?? "";
  throw new Error(
    [options.message, stderr ? `stderr:\n${stderr}` : "", stdout ? `stdout:\n${stdout}` : ""]
      .filter(Boolean)
      .join("\n\n"),
  );
}

function startSchedulerDaemon(workspace: string): DaemonProcess {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const child = spawn(
    "bun",
    [
      "run",
      "start",
      "--cwd",
      workspace,
      "--config",
      ".brewva/brewva.json",
      "--daemon",
      "--managed-tools",
      "direct",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...buildGatewayWorkerHarnessEnv({
          fakeAssistantText: "SCHEDULE_DAEMON_TEST_OK",
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!child.stdout || !child.stderr) {
    throw new Error("expected scheduler daemon stdio pipes");
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });

  return {
    child,
    readStdout: () => stdoutChunks.join(""),
    readStderr: () => stderrChunks.join(""),
  };
}

async function stopSchedulerDaemon(daemon: DaemonProcess): Promise<void> {
  if (daemon.child.exitCode !== null) {
    return;
  }

  const stopPromise = new Promise<void>((resolve, reject) => {
    daemon.child.once("close", (code, signal) => {
      if (signal && signal !== "SIGTERM") {
        reject(new Error(`scheduler daemon exited via signal ${signal}`));
        return;
      }
      if (code !== null && code !== 0) {
        reject(
          new Error(
            [
              `scheduler daemon exited with code ${code}`,
              daemon.readStderr() ? `stderr:\n${daemon.readStderr()}` : "",
              daemon.readStdout() ? `stdout:\n${daemon.readStdout()}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        );
        return;
      }
      resolve();
    });

    daemon.child.kill("SIGTERM");
  });
  const timeoutMessage = "scheduler daemon did not stop after SIGTERM";
  try {
    await withTimeout(stopPromise, 8_000, timeoutMessage);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === timeoutMessage &&
      daemon.child.exitCode === null
    ) {
      daemon.child.kill("SIGKILL");
      throw new Error(
        [
          timeoutMessage,
          daemon.readStderr() ? `stderr:\n${daemon.readStderr()}` : "",
          daemon.readStdout() ? `stdout:\n${daemon.readStdout()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        { cause: error },
      );
    }
    throw error;
  }
}

describe("system: scheduler daemon", () => {
  test(
    "daemon catch-up executes a scheduled run through the shared session backend",
    async () => {
      const workspace = createWorkspace("scheduler-daemon");
      writeMinimalConfig(workspace, {
        schedule: {
          enabled: true,
          minIntervalMs: 100,
        },
        infrastructure: {
          events: {
            enabled: true,
          },
        },
      });
      mkdirSync(join(workspace, ".brewva"), { recursive: true });

      const parentSessionId = asBrewvaSessionId("scheduler-parent-session");
      const parentTaskGoal = "Finish the release checklist";
      const claimSummary = "Release notes are waiting for final reviewer approval.";

      const setupRuntime = createRuntimeInstanceFixture({
        cwd: workspace,
        configPath: ".brewva/brewva.json",
      });
      setupRuntime.ops.task.spec.set(parentSessionId, {
        schema: "brewva.task.v1",
        goal: parentTaskGoal,
      });
      setupRuntime.ops.claim.facts.upsert(parentSessionId, {
        id: "fact-release-review",
        kind: "status",
        severity: "warn",
        summary: claimSummary,
      });
      setupRuntime.ops.tape.handoff.record(parentSessionId, {
        name: "release-checkpoint",
        summary: "Release prep is partially complete.",
        nextSteps: "Resolve the final reviewer comment.",
      });
      const created = await setupRuntime.ops.schedule.intents.create(parentSessionId, {
        intentId: asBrewvaIntentId("intent-scheduler-daemon"),
        reason: "nightly release follow-up",
        continuityMode: "inherit",
        runAt: Date.now() + 500,
        maxRuns: 1,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        cleanupWorkspace(workspace);
        return;
      }

      const daemon = startSchedulerDaemon(workspace);

      try {
        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: ".brewva/brewva.json",
        });
        const started = await waitForCondition(
          () =>
            observer.ops.events.records.query(parentSessionId, {
              type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
              last: 1,
            })[0],
          {
            message: "expected scheduler daemon to start a child session",
            daemon,
            timeoutMs: SCHEDULER_DAEMON_WAIT_TIMEOUT_MS,
          },
        );
        const childSessionId =
          typeof started?.payload?.childSessionId === "string"
            ? started.payload.childSessionId
            : "";
        expect(childSessionId.length).toBeGreaterThan(0);

        await waitForCondition(
          () =>
            observer.ops.events.records.query(parentSessionId, {
              type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
              last: 1,
            })[0],
          {
            message: "expected scheduler daemon to finish the scheduled child session",
            daemon,
            timeoutMs: SCHEDULER_DAEMON_WAIT_TIMEOUT_MS,
          },
        );

        await waitForCondition(
          () =>
            observer.ops.events.records
              .query(parentSessionId, { type: SCHEDULE_EVENT_TYPE })
              .map((event) => parseScheduleIntentEvent(event)?.kind)
              .find((kind) => kind === "intent_converged"),
          {
            message: "expected scheduler daemon to converge the scheduled intent",
            daemon,
            timeoutMs: SCHEDULER_DAEMON_WAIT_TIMEOUT_MS,
          },
        );

        const persisted = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: ".brewva/brewva.json",
        });
        const wakeup = persisted.ops.events.records.query(childSessionId, {
          type: SCHEDULE_WAKEUP_EVENT_TYPE,
          last: 1,
        })[0];
        expect(wakeup?.payload).toMatchObject({
          intentId: "intent-scheduler-daemon",
          parentSessionId,
          inheritedTaskSpec: true,
          inheritedOperationalClaims: 1,
        });

        const childTask = persisted.ops.task.state.get(childSessionId);
        expect(childTask.spec?.goal).toBe(parentTaskGoal);
        const childClaim = persisted.ops.claim.state.get(childSessionId);
        expect(childClaim.claims).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "fact-release-review",
              summary: claimSummary,
              status: "active",
            }),
          ]),
        );

        const childTapeStatus = persisted.ops.tape.status.get(childSessionId);
        expect(childTapeStatus.lastAnchor?.name).toBe("schedule:inherit:release-checkpoint");

        const scheduleKinds = persisted.ops.events.records
          .query(parentSessionId, { type: SCHEDULE_EVENT_TYPE })
          .map((event) => parseScheduleIntentEvent(event)?.kind)
          .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
        expect(scheduleKinds).toContain("intent_created");
        expect(scheduleKinds).toContain("intent_fired");
        expect(scheduleKinds).toContain("intent_converged");

        const intents = await persisted.ops.schedule.intents.list({ parentSessionId });
        expect(intents).toEqual([
          expect.objectContaining({
            intentId: created.intent.intentId,
            status: "converged",
            runCount: 1,
            nextRunAt: undefined,
          }),
        ]);
      } finally {
        await stopSchedulerDaemon(daemon);
        cleanupWorkspace(workspace);
      }
    },
    SCHEDULER_DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "daemon seeds a single durable autonomous self-improve schedule from config",
    async () => {
      const workspace = createWorkspace("scheduler-daemon-self-improve");
      writeMinimalConfig(workspace, {
        schedule: {
          enabled: true,
          selfImprove: {
            enabled: true,
            parentSessionId: "policy-self-improve-parent",
            intentId: "policy-self-improve-intent",
            reason: "Run self-improve automatically from the scheduler policy.",
            goalRef: "policy:self-improve",
            continuityMode: "inherit",
            cron: "0 0 1 1 *",
            maxRuns: 321,
            taskSpec: {
              goal: "Run self-improve on repeated repository friction.",
              expectedBehavior:
                "Load self-improve, inspect repeated evidence, and stop without writes when the pattern is not repeat-backed.",
              constraints: [
                "Do not write repository files directly from the scheduled run.",
                "Only emit promotion candidates after repeated evidence.",
              ],
            },
          },
        },
        infrastructure: {
          events: {
            enabled: true,
          },
        },
      });
      mkdirSync(join(workspace, ".brewva"), { recursive: true });

      const firstDaemon = await startGatewayDaemonHarness({ workspace });
      try {
        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: ".brewva/brewva.json",
        });
        const seededIntent = await waitForCondition(
          async () => {
            const intents = await observer.ops.schedule.intents.list({
              parentSessionId: asBrewvaSessionId("policy-self-improve-parent"),
            });
            return intents.find((intent) => intent.intentId === "policy-self-improve-intent");
          },
          {
            message: "expected daemon to seed the autonomous self-improve schedule intent",
            timeoutMs: SCHEDULER_DAEMON_WAIT_TIMEOUT_MS,
          },
        );
        const cancelled = await observer.ops.schedule.intents.cancel("policy-self-improve-parent", {
          intentId: seededIntent.intentId,
          reason: "operator_cancelled_for_restart_reconcile_test",
        });
        expect(cancelled.ok).toBe(true);
      } finally {
        await firstDaemon.dispose();
      }

      const secondDaemon = await startGatewayDaemonHarness({ workspace });
      try {
        const observer = createRuntimeInstanceFixture({
          cwd: workspace,
          configPath: ".brewva/brewva.json",
        });
        const intent = await waitForCondition(
          async () => {
            const intents = await observer.ops.schedule.intents.list({
              parentSessionId: asBrewvaSessionId("policy-self-improve-parent"),
            });
            return intents.length === 1 ? intents[0] : null;
          },
          {
            message:
              "expected daemon restart to keep exactly one autonomous self-improve schedule intent",
            timeoutMs: SCHEDULER_DAEMON_WAIT_TIMEOUT_MS,
          },
        );

        expect(intent).toMatchObject({
          intentId: "policy-self-improve-intent",
          parentSessionId: "policy-self-improve-parent",
          reason: "Run self-improve automatically from the scheduler policy.",
          goalRef: "policy:self-improve",
          continuityMode: "inherit",
          cron: "0 0 1 1 *",
          maxRuns: 321,
          status: "active",
        });
        expect(typeof intent.nextRunAt).toBe("number");
      } finally {
        await secondDaemon.dispose();
        cleanupWorkspace(workspace);
      }
    },
    SCHEDULER_DAEMON_TEST_TIMEOUT_MS,
  );
});
