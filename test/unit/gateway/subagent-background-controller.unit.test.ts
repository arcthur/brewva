import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDetachedSubagentBackgroundController,
  type HostedSubagentProfile,
} from "@brewva/brewva-gateway";
import { BrewvaRuntime } from "@brewva/brewva-runtime";

function createTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const RESEARCHER_PROFILE: HostedSubagentProfile = {
  name: "researcher",
  description: "Repository exploration worker.",
  resultMode: "exploration",
  prompt: "Inspect the repository and summarize findings.",
  posture: "observe",
  builtinToolNames: ["read"],
};

describe("detached subagent background controller", () => {
  test("startRun persists durable live state and reports a live run", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-controller-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    let pidAlive = true;

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 43210,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return pidAlive;
      },
    });

    const run = await controller.startRun({
      parentSessionId: "parent-bg-1",
      profile: RESEARCHER_PROFILE,
      packet: {
        objective: "Inspect the runtime package.",
      },
    });

    const live = await controller.inspectLiveRuns({
      parentSessionId: "parent-bg-1",
      query: { runIds: [run.runId] },
    });

    expect(run.status).toBe("pending");
    expect(live.get(run.runId)).toEqual({
      live: true,
      cancelable: true,
    });
    expect(
      existsSync(join(workspaceRoot, ".orchestrator", "subagent-runs", run.runId, "spec.json")),
    ).toBe(true);

    pidAlive = false;
  });

  test("cancelRun reconciles a dead detached pid into cancelled instead of not_live_in_this_process", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-cancel-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    let pidAlive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 43211,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return pidAlive;
      },
      sendSignal(pid, signal) {
        signals.push({ pid, signal });
        pidAlive = false;
      },
    });

    const run = await controller.startRun({
      parentSessionId: "parent-bg-cancel",
      profile: RESEARCHER_PROFILE,
      packet: {
        objective: "Inspect the gateway package.",
      },
    });

    const cancelled = await controller.cancelRun({
      parentSessionId: "parent-bg-cancel",
      runId: run.runId,
      reason: "manual_stop",
    });

    expect(signals).toEqual([{ pid: 43211, signal: "SIGTERM" }]);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.run).toMatchObject({
      runId: run.runId,
      status: "cancelled",
      live: false,
      cancelable: false,
    });
  });

  test("cancelSessionRuns issues cancellation requests for every live run in the parent session", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-session-cancel-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let nextPid = 45000;

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: nextPid++,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
      sendSignal(pid, signal) {
        signals.push({ pid, signal });
      },
    });

    const first = await controller.startRun({
      parentSessionId: "parent-bg-session",
      profile: RESEARCHER_PROFILE,
      packet: {
        objective: "Inspect runtime package.",
      },
    });
    await controller.startRun({
      parentSessionId: "parent-bg-session",
      profile: RESEARCHER_PROFILE,
      packet: {
        objective: "Inspect gateway package.",
      },
    });
    await controller.startRun({
      parentSessionId: "other-parent",
      profile: RESEARCHER_PROFILE,
      packet: {
        objective: "Ignore this run.",
      },
    });

    await controller.cancelSessionRuns?.("parent-bg-session", "session_teardown");

    expect(signals.toSorted((left, right) => left.pid - right.pid)).toEqual([
      { pid: 45000, signal: "SIGTERM" },
      { pid: 45001, signal: "SIGTERM" },
    ]);
    expect(
      existsSync(join(workspaceRoot, ".orchestrator", "subagent-runs", first.runId, "cancel.json")),
    ).toBe(true);
  });
});
