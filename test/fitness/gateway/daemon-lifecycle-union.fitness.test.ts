import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./shared.js";

const daemonKinds = [
  "starting",
  "listening",
  "scheduler-paused",
  "scheduler-resumed",
  "stopping",
  "stopped",
] as const;
const workerKinds = ["spawned", "ready", "busy", "recovering", "closing", "closed"] as const;

describe("daemon lifecycle union", () => {
  test("defines daemon lifecycle event kinds", () => {
    const source = readRepoFile("packages/brewva-gateway/src/daemon/types.ts");
    for (const kind of daemonKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
    for (const kind of workerKinds) {
      expect(source).toContain(`kind: "${kind}"`);
    }
  });

  test("routes daemon and worker transitions through typed lifecycle seams", () => {
    const daemonTypes = readRepoFile("packages/brewva-gateway/src/daemon/types.ts");
    const daemon = readRepoFile("packages/brewva-gateway/src/daemon/gateway-daemon.ts");
    const supervisor = readRepoFile(
      "packages/brewva-gateway/src/daemon/session-supervisor/index.ts",
    );
    const workerState = readRepoFile(
      "packages/brewva-gateway/src/daemon/session-supervisor/worker-state.ts",
    );
    const workerRpc = readRepoFile(
      "packages/brewva-gateway/src/daemon/session-supervisor/worker-rpc.ts",
    );

    expect(daemonTypes).toContain("createDaemonStartingEvent");
    expect(daemonTypes).toContain("createDaemonListeningEvent");
    expect(daemonTypes).toContain("createDaemonStoppingEvent");
    expect(daemonTypes).toContain("createWorkerSpawnedState");
    expect(daemonTypes).toContain("createWorkerBusyState");
    expect(daemon).toContain("type DaemonLifecycleEvent");
    expect(daemon).toContain("createDaemonStartingEvent");
    expect(daemon).toContain("createDaemonListeningEvent");
    expect(daemon).toContain("createDaemonStoppingEvent");
    expect(daemon).toContain("createDaemonStoppedEvent");
    expect(daemon).toContain("createDaemonSchedulerPausedEvent");
    expect(daemon).toContain("createDaemonSchedulerResumedEvent");
    expect(workerState).toContain("lifecycleState: WorkerLifecycleState");
    expect(supervisor).toContain("createWorkerSpawnedState");
    expect(supervisor).toContain("createWorkerReadyState");
    expect(workerRpc).toContain("createWorkerBusyState");
    expect(workerRpc).toContain("createWorkerReadyState");
    expect(workerRpc).toContain("createWorkerClosedState");
  });
});
