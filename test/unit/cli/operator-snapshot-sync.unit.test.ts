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

  test("re-opens the approval overlay after it was dismissed while still pending", async () => {
    const approval = {
      requestId: "approval-1",
      subject: "swift build -c release",
      toolName: "exec",
      boundary: "effectful",
    } as OperatorSurfaceSnapshot["approvals"][number];
    // Two snapshots with different signatures (a task run comes and goes) but the
    // SAME pending approval throughout — the approval is never decided.
    const withTask: OperatorSurfaceSnapshot = {
      approvals: [approval],
      questions: [],
      taskRuns: [{ runId: "run-1" }] as OperatorSurfaceSnapshot["taskRuns"],
      sessions: [],
    };
    const withoutTask: OperatorSurfaceSnapshot = {
      approvals: [approval],
      questions: [],
      taskRuns: [],
      sessions: [],
    };
    let snapshot: OperatorSurfaceSnapshot = withoutTask;
    const openedApprovalOverlays: unknown[] = [];
    // The operator dismissed the overlay: nothing is presenting it anymore.
    let overlayShowsApproval = false;

    const sync = new ShellOperatorSnapshotSync({
      isDisposed: () => false,
      getSessionGeneration: () => 1,
      getState: () =>
        ({
          status: { safety: undefined },
          overlay: {
            active: overlayShowsApproval ? { payload: { kind: "approval" } } : undefined,
            queue: [],
          },
        }) as unknown as CliShellViewState,
      getSnapshot: async () => snapshot,
      setSnapshot() {},
      commit() {},
      overlayHandler: {
        syncSnapshotOverlay() {},
        openOverlay(payload: { kind?: string }) {
          if (payload.kind === "approval") {
            openedApprovalOverlays.push(payload);
            overlayShowsApproval = true;
          }
        },
      } as unknown as ShellOverlayLifecycleHandler,
    });

    // First sync: approval surfaces, overlay opens.
    await sync.refresh();
    expect(openedApprovalOverlays).toHaveLength(1);

    // The operator presses escape — the overlay closes but the approval is still
    // pending (never decided).
    overlayShowsApproval = false;

    // A later snapshot change (unrelated task run) re-runs the sync. The still-
    // pending approval, now unpresented, must surface again — not stay buried
    // behind a one-shot "already seen" guard.
    snapshot = withTask;
    await sync.refresh();
    expect(openedApprovalOverlays).toHaveLength(2);
  });

  test("does not re-open the approval overlay while it is still being presented", async () => {
    const approval = {
      requestId: "approval-1",
      subject: "swift build",
      toolName: "exec",
      boundary: "effectful",
    } as OperatorSurfaceSnapshot["approvals"][number];
    const withTask: OperatorSurfaceSnapshot = {
      approvals: [approval],
      questions: [],
      taskRuns: [{ runId: "run-1" }] as OperatorSurfaceSnapshot["taskRuns"],
      sessions: [],
    };
    const withoutTask: OperatorSurfaceSnapshot = {
      approvals: [approval],
      questions: [],
      taskRuns: [],
      sessions: [],
    };
    let snapshot: OperatorSurfaceSnapshot = withoutTask;
    const openedApprovalOverlays: unknown[] = [];
    let overlayShowsApproval = false;

    const sync = new ShellOperatorSnapshotSync({
      isDisposed: () => false,
      getSessionGeneration: () => 1,
      getState: () =>
        ({
          status: { safety: undefined },
          overlay: {
            active: overlayShowsApproval ? { payload: { kind: "approval" } } : undefined,
            queue: [],
          },
        }) as unknown as CliShellViewState,
      getSnapshot: async () => snapshot,
      setSnapshot() {},
      commit() {},
      overlayHandler: {
        syncSnapshotOverlay() {},
        openOverlay(payload: { kind?: string }) {
          if (payload.kind === "approval") {
            openedApprovalOverlays.push(payload);
            overlayShowsApproval = true;
          }
        },
      } as unknown as ShellOverlayLifecycleHandler,
    });

    await sync.refresh();
    expect(openedApprovalOverlays).toHaveLength(1);

    // The overlay is still up; an unrelated snapshot change must not stack a
    // second approval overlay on top of the one already presented.
    snapshot = withTask;
    await sync.refresh();
    expect(openedApprovalOverlays).toHaveLength(1);
  });
});
