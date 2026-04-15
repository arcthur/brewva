import { describe, expect, test } from "bun:test";
import { createCliShellState, reduceCliShellState } from "@brewva/brewva-cli/shell/state";

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

    expect(state.overlay.active).toBeUndefined();
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
});
