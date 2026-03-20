import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  parseScheduleIntentEvent,
} from "@brewva/brewva-runtime";
import { cleanupWorkspace, createWorkspace, repoRoot, writeMinimalConfig } from "../helpers.js";
import { buildGatewayWorkerHarnessEnv } from "../helpers/gateway.js";

interface DaemonProcess {
  child: ChildProcess;
  readStdout(): string;
  readStderr(): string;
}

async function waitForCondition<T>(
  check: () => T | null | undefined,
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
    const value = check();
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

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref?.();
    });
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
      "--no-extensions",
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

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      daemon.child.kill("SIGKILL");
      reject(
        new Error(
          [
            "scheduler daemon did not stop after SIGTERM",
            daemon.readStderr() ? `stderr:\n${daemon.readStderr()}` : "",
            daemon.readStdout() ? `stdout:\n${daemon.readStdout()}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    }, 8_000);
    timer.unref?.();

    daemon.child.once("close", (code, signal) => {
      clearTimeout(timer);
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
}

describe("system: scheduler daemon", () => {
  test("daemon catch-up executes a scheduled run through the shared session backend", async () => {
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

    const parentSessionId = "scheduler-parent-session";
    const parentTaskGoal = "Finish the release checklist";
    const truthSummary = "Release notes are waiting for final reviewer approval.";

    const setupRuntime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    setupRuntime.task.setSpec(parentSessionId, {
      schema: "brewva.task.v1",
      goal: parentTaskGoal,
    });
    setupRuntime.truth.upsertFact(parentSessionId, {
      id: "fact-release-review",
      kind: "status",
      severity: "warn",
      summary: truthSummary,
    });
    setupRuntime.events.recordTapeHandoff(parentSessionId, {
      name: "release-checkpoint",
      summary: "Release prep is partially complete.",
      nextSteps: "Resolve the final reviewer comment.",
    });
    const created = await setupRuntime.schedule.createIntent(parentSessionId, {
      intentId: "intent-scheduler-daemon",
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
      const observer = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
      const started = await waitForCondition(
        () =>
          observer.events.query(parentSessionId, {
            type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
            last: 1,
          })[0],
        {
          message: "expected scheduler daemon to start a child session",
          daemon,
        },
      );
      const childSessionId =
        typeof started?.payload?.childSessionId === "string" ? started.payload.childSessionId : "";
      expect(childSessionId.length).toBeGreaterThan(0);

      await waitForCondition(
        () =>
          observer.events.query(parentSessionId, {
            type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
            last: 1,
          })[0],
        {
          message: "expected scheduler daemon to finish the scheduled child session",
          daemon,
        },
      );

      await waitForCondition(
        () =>
          observer.events
            .query(parentSessionId, { type: SCHEDULE_EVENT_TYPE })
            .map((event) => parseScheduleIntentEvent(event)?.kind)
            .find((kind) => kind === "intent_converged"),
        {
          message: "expected scheduler daemon to converge the scheduled intent",
          daemon,
        },
      );

      const persisted = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
      const wakeup = persisted.events.query(childSessionId, {
        type: SCHEDULE_WAKEUP_EVENT_TYPE,
        last: 1,
      })[0];
      expect(wakeup?.payload).toMatchObject({
        intentId: "intent-scheduler-daemon",
        parentSessionId,
        inheritedTaskSpec: true,
        inheritedTruthFacts: 1,
      });

      const childTask = persisted.task.getState(childSessionId);
      expect(childTask.spec?.goal).toBe(parentTaskGoal);

      const childTruth = persisted.truth.getState(childSessionId);
      expect(childTruth.facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fact-release-review",
            summary: truthSummary,
            status: "active",
          }),
        ]),
      );

      const childTapeStatus = persisted.events.getTapeStatus(childSessionId);
      expect(childTapeStatus.lastAnchor?.name).toBe("schedule:inherit:release-checkpoint");

      const scheduleKinds = persisted.events
        .query(parentSessionId, { type: SCHEDULE_EVENT_TYPE })
        .map((event) => parseScheduleIntentEvent(event)?.kind)
        .filter((kind): kind is NonNullable<typeof kind> => Boolean(kind));
      expect(scheduleKinds).toContain("intent_created");
      expect(scheduleKinds).toContain("intent_fired");
      expect(scheduleKinds).toContain("intent_converged");

      const intents = await persisted.schedule.listIntents({ parentSessionId });
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
  });
});
