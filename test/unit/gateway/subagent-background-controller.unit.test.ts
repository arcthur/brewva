import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDetachedSubagentBackgroundController,
  HostedDelegationStore,
  type HostedDelegationTarget,
} from "@brewva/brewva-gateway";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { DelegationPacket } from "@brewva/brewva-tools";

function createTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const ADVISOR_TARGET: HostedDelegationTarget = {
  name: "advisor",
  description: "Repository investigation advisor.",
  resultMode: "consult",
  consultKind: "investigate",
  executorPreamble: "Inspect the repository and summarize the strongest evidence-backed findings.",
  agentSpecName: "advisor",
  envelopeName: "readonly-advisor",
  boundary: "safe",
  builtinToolNames: ["read"],
  producesPatches: false,
  contextProfile: "minimal",
};

function buildAdvisorPacket(
  objective: string,
  overrides: Partial<DelegationPacket> = {},
): DelegationPacket {
  return {
    objective,
    consultBrief: {
      decision: "What should the advisor determine for the parent next?",
      successCriteria: "Return a bounded, evidence-backed consult result.",
    },
    ...overrides,
  };
}

describe("detached subagent background controller", () => {
  test("startRun persists durable live state and reports a live run", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-controller-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const delegationStore = new HostedDelegationStore(runtime);
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
      target: ADVISOR_TARGET,
      packet: {
        objective: "Inspect the runtime package.",
        consultBrief: {
          decision: "Which runtime files should the parent inspect first?",
          successCriteria: "Return the highest-signal starting points with evidence.",
        },
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
      agentSpecName?: string;
      envelopeName?: string;
      skillName?: string;
      config: {
        infrastructure?: {
          events?: {
            level?: string;
          };
        };
      };
    };
    expect(spec.schema).toBe("brewva.subagent-run-spec.v7");
    expect(spec.agentSpecName).toBe("advisor");
    expect(spec.envelopeName).toBe("readonly-advisor");
    expect(spec.skillName).toBeUndefined();
    expect(spec.config.infrastructure?.events?.level).toBe("audit");
    expect(delegationStore.getRun("parent-bg-1", run.runId)).toMatchObject({
      agentSpec: "advisor",
      envelope: "readonly-advisor",
      kind: "consult",
      consultKind: "investigate",
    });

    pidAlive = false;
  });

  test("event completion predicates cancel live runs once the parent evidence is satisfied", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-predicate-event-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const delegationStore = new HostedDelegationStore(runtime);
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
      target: ADVISOR_TARGET,
      packet: {
        objective: "Inspect the runtime package until merge evidence exists.",
        consultBrief: {
          decision: "What investigation remains necessary before merge evidence exists?",
          successCriteria: "Keep the run alive until merge evidence is observed.",
        },
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

    recordRuntimeEvent(runtime, {
      sessionId: "parent-bg-predicate-event",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-99",
      },
    });

    let terminal = delegationStore.getRun("parent-bg-predicate-event", run.runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      terminal = delegationStore.getRun("parent-bg-predicate-event", run.runId);
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
    const delegationStore = new HostedDelegationStore(runtime);
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
      target: ADVISOR_TARGET,
      packet: {
        objective: "Inspect the gateway package until worker application succeeds.",
        consultBrief: {
          decision: "What investigation remains necessary before worker application succeeds?",
          successCriteria: "Stop once worker application is observed.",
        },
        completionPredicate: {
          source: "worker_results",
          workerId: "worker-apply-1",
          status: "ok",
          policy: "cancel_when_true",
        },
      },
    });

    runtime.maintain.session.recordWorkerResult("parent-bg-predicate-worker", {
      workerId: "worker-apply-1",
      status: "ok",
      summary: "Patch merged.",
    });
    recordRuntimeEvent(runtime, {
      sessionId: "parent-bg-predicate-worker",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-apply-1",
      },
    });

    let terminal = delegationStore.getRun("parent-bg-predicate-worker", run.runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      terminal = delegationStore.getRun("parent-bg-predicate-worker", run.runId);
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
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect the gateway package."),
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
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect runtime package."),
    });
    await controller.startRun({
      parentSessionId: "parent-bg-session",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect gateway package."),
    });
    await controller.startRun({
      parentSessionId: "other-parent",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Ignore this run."),
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

  test("startRun rejects new detached work when the session parallel budget is already saturated", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-slot-budget-");
    const runtime = new BrewvaRuntime({
      cwd: workspaceRoot,
      config: {
        ...structuredClone(DEFAULT_BREWVA_CONFIG),
        parallel: {
          ...DEFAULT_BREWVA_CONFIG.parallel,
          enabled: true,
          maxConcurrent: 1,
          maxTotalPerSession: 4,
        },
      },
    });
    let nextPid = 47000;
    let spawnCalls = 0;
    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        spawnCalls += 1;
        return {
          pid: nextPid++,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
    });

    const first = await controller.startRun({
      parentSessionId: "parent-bg-slot-budget",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect runtime package."),
    });
    const second = await controller.startRun({
      parentSessionId: "parent-bg-slot-budget",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect gateway package."),
    });

    expect(first.status).toBe("pending");
    expect(second.status).toBe("failed");
    expect(second.summary).toBe("parallel_slot_rejected:max_concurrent");
    expect(spawnCalls).toBe(1);
  });

  test("restored detached live runs continue to consume parallel budget after parent restart", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-slot-restore-");
    const config = {
      ...structuredClone(DEFAULT_BREWVA_CONFIG),
      parallel: {
        ...DEFAULT_BREWVA_CONFIG.parallel,
        enabled: true,
        maxConcurrent: 1,
        maxTotalPerSession: 4,
      },
    };
    const runtime = new BrewvaRuntime({
      cwd: workspaceRoot,
      config,
    });
    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 48001,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
    });

    const first = await controller.startRun({
      parentSessionId: "parent-bg-slot-restore",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect runtime package."),
    });

    const restartedRuntime = new BrewvaRuntime({
      cwd: workspaceRoot,
      config,
    });
    let spawnCalls = 0;
    const restartedController = createDetachedSubagentBackgroundController({
      runtime: restartedRuntime,
      spawnProcess() {
        spawnCalls += 1;
        return {
          pid: 48002,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
    });

    const second = await restartedController.startRun({
      parentSessionId: "parent-bg-slot-restore",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect gateway package."),
    });

    expect(first.status).toBe("pending");
    expect(second.status).toBe("failed");
    expect(second.summary).toBe("parallel_slot_rejected:max_concurrent");
    expect(spawnCalls).toBe(0);
  });

  test("pre-satisfied completion predicates record a terminal cancellation without spawning", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-predicate-preflight-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    let spawnCalls = 0;
    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        spawnCalls += 1;
        return {
          pid: 49001,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
    });

    recordRuntimeEvent(runtime, {
      sessionId: "parent-bg-predicate-preflight",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-preflight-1",
      },
    });

    const run = await controller.startRun({
      parentSessionId: "parent-bg-predicate-preflight",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect runtime until an applied worker result exists.", {
        completionPredicate: {
          source: "events",
          type: "worker_results_applied",
          match: {
            workerId: "worker-preflight-1",
          },
          policy: "cancel_when_true",
        },
      }),
    });

    expect(run.status).toBe("cancelled");
    expect(run.summary).toBe("completion_predicate_satisfied");
    expect(spawnCalls).toBe(0);
    expect(
      existsSync(join(workspaceRoot, ".orchestrator", "subagent-runs", run.runId, "spec.json")),
    ).toBe(false);
  });

  test("inspectLiveRuns replays completion predicates after restart and cancels already-satisfied runs", async () => {
    const workspaceRoot = createTempWorkspace("brewva-subagent-bg-predicate-restart-");
    const runtime = new BrewvaRuntime({ cwd: workspaceRoot });
    const controller = createDetachedSubagentBackgroundController({
      runtime,
      spawnProcess() {
        return {
          pid: 50001,
          unref() {},
        } as any;
      },
      isPidAlive() {
        return true;
      },
    });

    const run = await controller.startRun({
      parentSessionId: "parent-bg-predicate-restart",
      target: ADVISOR_TARGET,
      packet: buildAdvisorPacket("Inspect runtime package until merge evidence exists.", {
        completionPredicate: {
          source: "events",
          type: "worker_results_applied",
          match: {
            workerId: "worker-restart-1",
          },
          policy: "cancel_when_true",
        },
      }),
    });

    const restartedRuntime = new BrewvaRuntime({ cwd: workspaceRoot });
    const restartedStore = new HostedDelegationStore(restartedRuntime);
    let pidAlive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const restartedController = createDetachedSubagentBackgroundController({
      runtime: restartedRuntime,
      delegationStore: restartedStore,
      spawnProcess() {
        return {
          pid: 50002,
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

    recordRuntimeEvent(restartedRuntime, {
      sessionId: "parent-bg-predicate-restart",
      type: "worker_results_applied",
      payload: {
        workerId: "worker-restart-1",
      },
    });

    const liveRuns = await restartedController.inspectLiveRuns({
      parentSessionId: "parent-bg-predicate-restart",
      query: { runIds: [run.runId] },
    });
    const terminal = restartedStore.getRun("parent-bg-predicate-restart", run.runId);

    expect(signals).toEqual([{ pid: 50001, signal: "SIGTERM" }]);
    expect(liveRuns.get(run.runId)).toEqual({
      live: false,
      cancelable: false,
    });
    expect(terminal).toMatchObject({
      runId: run.runId,
      status: "cancelled",
      summary: "completion_predicate_satisfied",
    });
  });
});
