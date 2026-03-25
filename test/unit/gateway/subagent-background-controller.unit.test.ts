import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

const EXPLORE_PROFILE: HostedSubagentProfile = {
  name: "explore",
  description: "Repository exploration worker.",
  resultMode: "exploration",
  prompt: "Inspect the repository and summarize findings.",
  boundary: "safe",
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
      profile: EXPLORE_PROFILE,
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
    const spec = JSON.parse(
      readFileSync(
        join(workspaceRoot, ".orchestrator", "subagent-runs", run.runId, "spec.json"),
        "utf8",
      ),
    ) as {
      schema: string;
      config: {
        infrastructure?: {
          events?: {
            level?: string;
          };
        };
      };
    };
    expect(spec.schema).toBe("brewva.subagent-run-spec.v3");
    expect(spec.config.infrastructure?.events?.level).toBe("audit");

    pidAlive = false;
  });

  test("event completion predicates cancel live runs once the parent evidence is satisfied", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-predicate-event-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    let pidAlive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 43212,
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
      parentSessionId: "parent-bg-predicate-event",
      profile: EXPLORE_PROFILE,
      packet: {
        objective: "Inspect the runtime package until merge evidence exists.",
        completionPredicate: {
          source: "events",
          type: "worker_results_applied",
          match: {
            workerId: "worker-99",
          },
          policy: "cancel_when_true",
        },
      },
    });

    runtime.events.record({
      sessionId: "parent-bg-predicate-event",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-99",
      },
    });

    let terminal = runtime.session.getDelegationRun("parent-bg-predicate-event", run.runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      terminal = runtime.session.getDelegationRun("parent-bg-predicate-event", run.runId);
      if (terminal?.status === "cancelled") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(signals).toEqual([{ pid: 43212, signal: "SIGTERM" }]);
    expect(terminal).toMatchObject({
      runId: run.runId,
      status: "cancelled",
      summary: "completion_predicate_satisfied",
    });
  });

  test("worker-result completion predicates observe session state on later parent events", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-predicate-worker-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    let pidAlive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 43213,
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
      parentSessionId: "parent-bg-predicate-worker",
      profile: EXPLORE_PROFILE,
      packet: {
        objective: "Inspect the gateway package until worker application succeeds.",
        completionPredicate: {
          source: "worker_results",
          workerId: "worker-apply-1",
          status: "ok",
          policy: "cancel_when_true",
        },
      },
    });

    runtime.session.recordWorkerResult("parent-bg-predicate-worker", {
      workerId: "worker-apply-1",
      status: "ok",
      summary: "Patch merged.",
    });
    runtime.events.record({
      sessionId: "parent-bg-predicate-worker",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-apply-1",
      },
    });

    let terminal = runtime.session.getDelegationRun("parent-bg-predicate-worker", run.runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      terminal = runtime.session.getDelegationRun("parent-bg-predicate-worker", run.runId);
      if (terminal?.status === "cancelled") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(signals).toEqual([{ pid: 43213, signal: "SIGTERM" }]);
    expect(terminal).toMatchObject({
      runId: run.runId,
      status: "cancelled",
      summary: "completion_predicate_satisfied",
    });
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
      profile: EXPLORE_PROFILE,
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
      profile: EXPLORE_PROFILE,
      packet: {
        objective: "Inspect runtime package.",
      },
    });
    await controller.startRun({
      parentSessionId: "parent-bg-session",
      profile: EXPLORE_PROFILE,
      packet: {
        objective: "Inspect gateway package.",
      },
    });
    await controller.startRun({
      parentSessionId: "other-parent",
      profile: EXPLORE_PROFILE,
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
