import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  type DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import {
  createCliShellState,
  reduceCliShellState,
} from "../../../packages/brewva-cli/src/shell/domain/state.js";

function run(input: Partial<DelegationRunRecord> & { runId: string }): DelegationRunRecord {
  return {
    contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
    agent: "worker",
    targetName: "worker",
    delegate: "worker",
    taskName: "implement-widget",
    taskPath: "/implement-widget",
    nickname: "Implement widget",
    depth: 1,
    forkTurns: "none",
    gateReason: "implement_isolated",
    modelCategory: "isolated-execution",
    executionPrimitive: "named",
    visibility: "public",
    isolationStrategy: "shared",
    adoption: {
      contractId: "shell-state-subagent-footer-test",
      decision: "require_human",
      reason: "Fixture run requires explicit adoption.",
    },
    parentSessionId: asBrewvaSessionId("parent-session"),
    status: "completed",
    createdAt: 100,
    updatedAt: 100,
    ...input,
  };
}

describe("cli shell state", () => {
  test("queues priority overlays without stealing focus and restores the composer focus after the queue drains", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "overlay.open",
      overlay: {
        id: "approval:1",
        kind: "approval",
        focusOwner: "approvalOverlay",
        priority: "queued",
      },
    });
    expect(state.overlay.active?.id).toBe("approval:1");
    expect(state.focus.active).toBe("approvalOverlay");

    state = reduceCliShellState(state, {
      type: "overlay.open",
      overlay: {
        id: "question:1",
        kind: "question",
        focusOwner: "questionOverlay",
        priority: "queued",
      },
    });

    expect(state.overlay.active?.id).toBe("approval:1");
    expect(state.overlay.queue.map((entry) => entry.id)).toEqual(["question:1"]);
    expect(state.focus.active).toBe("approvalOverlay");

    state = reduceCliShellState(state, {
      type: "overlay.close",
      id: "approval:1",
    });

    expect(state.overlay.active?.id).toBe("question:1");
    expect(state.focus.active).toBe("questionOverlay");

    state = reduceCliShellState(state, {
      type: "overlay.close",
      id: "question:1",
    });

    expect(state.overlay.active).toBe(undefined);
    expect(state.focus.active).toBe("composer");
  });

  test("marks transcript follow mode as scrolled when the operator leaves live tail", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "transcript.setMessages",
      messages: [
        {
          id: "assistant:1",
          role: "assistant",
          renderMode: "stable",
          parts: [{ id: "assistant:1:text:0", type: "text", text: "hello", renderMode: "stable" }],
        },
      ],
    });
    state = reduceCliShellState(state, {
      type: "transcript.scroll",
      delta: -5,
    });

    expect(state.transcript.followMode).toBe("scrolled");

    state = reduceCliShellState(state, {
      type: "transcript.followLive",
    });
    expect(state.transcript.followMode).toBe("live");
  });

  test("restores a suspended overlay after a drill-down pager closes", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "overlay.open",
      overlay: {
        id: "inspect:1",
        kind: "inspect",
        focusOwner: "inspectOverlay",
        priority: "normal",
      },
    });

    state = reduceCliShellState(state, {
      type: "overlay.open",
      overlay: {
        id: "pager:1",
        kind: "pager",
        focusOwner: "pager",
        priority: "normal",
        suspendFocusOwner: "inspectOverlay",
      },
    });

    expect(state.overlay.active?.id).toBe("pager:1");
    expect(state.overlay.queue.map((entry) => entry.id)).toEqual(["inspect:1"]);
    expect(state.focus.active).toBe("pager");

    state = reduceCliShellState(state, {
      type: "overlay.close",
      id: "pager:1",
    });

    expect(state.overlay.active?.id).toBe("inspect:1");
    expect(state.focus.active).toBe("inspectOverlay");
  });

  test("dismisses and clears notifications through explicit state actions", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "notification.add",
      notification: {
        id: "notification-1",
        level: "info",
        message: "first",
        createdAt: 1,
      },
    });
    state = reduceCliShellState(state, {
      type: "notification.add",
      notification: {
        id: "notification-2",
        level: "warning",
        message: "second",
        createdAt: 2,
      },
    });

    state = reduceCliShellState(state, {
      type: "notification.dismiss",
      id: "notification-1",
    });
    expect(state.notifications.map((notification) => notification.id)).toEqual(["notification-2"]);

    state = reduceCliShellState(state, {
      type: "notification.clear",
    });
    expect(state.notifications).toEqual([]);
  });

  test("leaves scrolled transcript anchoring to the app layer instead of guessing from entry count", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "transcript.setMessages",
      messages: [
        {
          id: "assistant:1",
          role: "assistant",
          renderMode: "stable",
          parts: [{ id: "assistant:1:text:0", type: "text", text: "hello", renderMode: "stable" }],
        },
      ],
    });
    state = reduceCliShellState(state, {
      type: "transcript.scroll",
      delta: 3,
    });

    expect(state.transcript.followMode).toBe("scrolled");
    expect(state.transcript.scrollOffset).toBe(3);

    state = reduceCliShellState(state, {
      type: "transcript.setMessages",
      messages: [
        ...state.transcript.messages,
        {
          id: "assistant:2",
          role: "assistant",
          renderMode: "stable",
          parts: [
            { id: "assistant:2:text:0", type: "text", text: "more output", renderMode: "stable" },
          ],
        },
      ],
    });

    expect(state.transcript.followMode).toBe("scrolled");
    expect(state.transcript.scrollOffset).toBe(3);
  });

  test("opens the subagent footer as a focused sibling surface and restores composer focus on close", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "operator.setTaskRuns",
      taskRuns: [
        run({
          runId: "run-1",
          status: "running",
          updatedAt: 200,
          workerSessionId: asBrewvaSessionId("worker-session-1"),
        }),
        run({
          runId: "run-2",
          status: "completed",
          updatedAt: 300,
          workerSessionId: asBrewvaSessionId("worker-session-2"),
        }),
      ],
    });
    state = reduceCliShellState(state, {
      type: "subagentFooter.open",
      runId: "run-1",
    });

    expect(state.subagentFooter.mode).toBe("inspecting");
    expect(state.subagentFooter.selectedRunId).toBe("run-1");
    expect(state.focus.active).toBe("subagentFooter");

    state = reduceCliShellState(state, {
      type: "subagentFooter.selectRelative",
      delta: 1,
    });

    expect(state.subagentFooter.selectedRunId).toBe("run-2");
    expect(state.subagentFooter.scrollOffset).toBe(0);

    state = reduceCliShellState(state, {
      type: "subagentFooter.close",
    });

    expect(state.subagentFooter.mode).toBe("collapsed");
    expect(state.focus.active).toBe("composer");
  });

  test("does not let the subagent footer steal focus from an active modal overlay", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "operator.setTaskRuns",
      taskRuns: [
        run({
          runId: "run-1",
          status: "running",
          workerSessionId: asBrewvaSessionId("worker-session-1"),
        }),
      ],
    });
    state = reduceCliShellState(state, {
      type: "overlay.open",
      overlay: {
        id: "tasks",
        kind: "tasks",
        focusOwner: "taskBrowser",
        priority: "queued",
      },
    });
    state = reduceCliShellState(state, {
      type: "subagentFooter.open",
      runId: "run-1",
    });

    expect(state.overlay.active?.id).toBe("tasks");
    expect(state.focus.active).toBe("taskBrowser");
    expect(state.focus.returnStack).toEqual(["composer"]);
    expect(state.subagentFooter.mode).toBe("collapsed");
    expect(state.subagentFooter.selectedRunId ?? null).toBe(null);
  });

  test("collapses the subagent footer when the selected run disappears", () => {
    let state = createCliShellState();

    state = reduceCliShellState(state, {
      type: "operator.setTaskRuns",
      taskRuns: [
        run({
          runId: "run-1",
          status: "running",
          workerSessionId: asBrewvaSessionId("worker-session-1"),
        }),
      ],
    });
    state = reduceCliShellState(state, {
      type: "subagentFooter.open",
      runId: "run-1",
    });

    expect(state.focus.active).toBe("subagentFooter");
    expect(state.subagentFooter.mode).toBe("inspecting");

    state = reduceCliShellState(state, {
      type: "operator.setTaskRuns",
      taskRuns: [],
    });

    expect(state.focus.active).toBe("composer");
    expect(state.subagentFooter.mode).toBe("collapsed");
    expect(state.subagentFooter.selectedRunId ?? null).toBe(null);
  });
});
