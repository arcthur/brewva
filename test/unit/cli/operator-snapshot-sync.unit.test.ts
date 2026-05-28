import { describe, expect, test } from "bun:test";
import { ShellOperatorSnapshotSync } from "../../../packages/brewva-cli/src/shell/controller/operator-snapshot-sync.js";
import type { ShellAction } from "../../../packages/brewva-cli/src/shell/domain/actions.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import type { CliShellViewState } from "../../../packages/brewva-cli/src/shell/domain/state.js";
import type { ShellOverlayLifecycleHandler } from "../../../packages/brewva-cli/src/shell/overlays/lifecycle.js";

describe("shell operator snapshot sync", () => {
  test("does not commit status actions when a polled snapshot is unchanged", async () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [],
    };
    const committed: ShellAction[][] = [];
    let activeSnapshot: OperatorSurfaceSnapshot = snapshot;
    let overlaySyncCount = 0;
    const sync = new ShellOperatorSnapshotSync({
      isDisposed: () => false,
      getSessionGeneration: () => 1,
      getState: () =>
        ({
          status: {
            safety: undefined,
          },
        }) as CliShellViewState,
      getSnapshot: async () => snapshot,
      setSnapshot(next) {
        activeSnapshot = next;
      },
      commit(actions) {
        committed.push([...actions]);
      },
      overlayHandler: {
        syncSnapshotOverlay() {
          overlaySyncCount += 1;
        },
        openOverlay() {},
      } as unknown as ShellOverlayLifecycleHandler,
    });

    expect(await sync.refresh()).toBe(true);
    expect(await sync.refresh()).toBe(false);

    expect(activeSnapshot).toBe(snapshot);
    expect(committed).toHaveLength(1);
    expect(overlaySyncCount).toBe(1);
  });

  test("uses a bounded snapshot signature instead of serializing arbitrary run payloads", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [
        {
          contractVersion: 4,
          runId: "run-1",
          parentSessionId: "session-1",
          agent: "worker",
          targetName: "target",
          taskName: "task",
          taskPath: "task.md",
          depth: 0,
          forkTurns: "none",
          gateReason: "manual",
          modelCategory: "default",
          delegate: "worker",
          status: "running",
          createdAt: 1_000,
          updatedAt: 1_001,
          resultData: circular,
        },
      ] as OperatorSurfaceSnapshot["taskRuns"],
      sessions: [],
    };
    const sync = new ShellOperatorSnapshotSync({
      isDisposed: () => false,
      getSessionGeneration: () => 1,
      getState: () =>
        ({
          status: {
            safety: undefined,
          },
        }) as CliShellViewState,
      getSnapshot: async () => snapshot,
      setSnapshot() {},
      commit() {},
      overlayHandler: {
        syncSnapshotOverlay() {},
        openOverlay() {},
      } as unknown as ShellOverlayLifecycleHandler,
    });

    expect(await sync.refresh()).toBe(true);
  });
});
