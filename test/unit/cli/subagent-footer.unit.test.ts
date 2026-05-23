import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  type DelegationRunRecord,
  type SessionWireFrame,
} from "@brewva/brewva-runtime/protocol";
import {
  buildSubagentFooterView,
  selectCompactSubagentFooterTabs,
} from "../../../packages/brewva-cli/src/shell/domain/subagent-footer.js";

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
      contractId: "subagent-footer-test",
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

function committedFrame(input: {
  sessionId: string;
  frameId: string;
  assistantText: string;
  toolText?: string;
}): SessionWireFrame {
  return {
    schema: "brewva.session-wire.v2",
    sessionId: asBrewvaSessionId(input.sessionId),
    frameId: input.frameId,
    ts: 200,
    source: "replay",
    durability: "durable",
    type: "turn.committed",
    turnId: "turn-1",
    attemptId: "attempt-1",
    status: "completed",
    assistantText: input.assistantText,
    toolOutputs: input.toolText
      ? [
          {
            toolCallId: asBrewvaToolCallId("tool-1"),
            toolName: asBrewvaToolName("exec"),
            verdict: "pass",
            isError: false,
            text: input.toolText,
          },
        ]
      : [],
  };
}

describe("subagent footer projection", () => {
  test("projects active-first tabs and selected worker session detail without transcript mixing", () => {
    const runs = [
      run({
        runId: "done-newer",
        status: "completed",
        updatedAt: 300,
        label: "Completed review",
        workerSessionId: asBrewvaSessionId("worker-done"),
      }),
      run({
        runId: "active-older",
        status: "running",
        updatedAt: 200,
        label: "Live patch",
        summary: "Inspecting renderer state",
        workerSessionId: asBrewvaSessionId("worker-live"),
      }),
    ];

    const view = buildSubagentFooterView({
      runs,
      state: {
        mode: "inspecting",
        selectedRunId: "active-older",
        scrollOffset: 0,
      },
      getSessionWireFrames: (sessionId) =>
        sessionId === "worker-live"
          ? [
              committedFrame({
                sessionId: "worker-live",
                frameId: "frame-1",
                assistantText: "Verifier summary line\nFound stale contract drift.",
                toolText: "bun test\n1775 pass",
              }),
            ]
          : [],
    });

    expect(view.visible).toBe(true);
    expect(view.mode).toBe("inspecting");
    expect(view.selectedRunId).toBe("active-older");
    expect(view.tabs.map((tab) => tab.runId)).toEqual(["active-older", "done-newer"]);
    expect(view.detail?.lines.join("\n")).toContain("Found stale contract drift.");
    expect(view.detail?.lines.join("\n")).toContain("1775 pass");
  });

  test("falls back to the first available tab when the selected run disappears", () => {
    const view = buildSubagentFooterView({
      runs: [
        run({
          runId: "replacement",
          status: "running",
          updatedAt: 400,
          workerSessionId: asBrewvaSessionId("worker-replacement"),
        }),
      ],
      state: {
        mode: "inspecting",
        selectedRunId: "removed-run",
        scrollOffset: 3,
      },
    });

    expect(view.selectedRunId).toBe("replacement");
    expect(view.detail?.runId).toBe("replacement");
    expect(view.detail?.lines.join("\n")).toContain(
      "No worker session output has been recorded yet.",
    );
  });

  test("keeps the selected run visible in compact tabs when it is outside the first window", () => {
    const view = buildSubagentFooterView({
      runs: Array.from({ length: 6 }, (_, index) =>
        run({
          runId: `run-${index}`,
          status: "completed",
          updatedAt: 600 - index,
          workerSessionId: asBrewvaSessionId(`worker-${index}`),
        }),
      ),
      state: {
        mode: "inspecting",
        selectedRunId: "run-5",
        scrollOffset: 0,
      },
    });

    expect(view.selectedRunId).toBe("run-5");
    expect(
      selectCompactSubagentFooterTabs({
        tabs: view.tabs,
        selectedRunId: view.selectedRunId,
        maxTabs: 5,
      }).map((tab) => tab.runId),
    ).toEqual(["run-0", "run-1", "run-2", "run-3", "run-5"]);
  });

  test("keeps the selected run visible when the renderer uses a narrower tab budget", () => {
    const view = buildSubagentFooterView({
      runs: Array.from({ length: 6 }, (_, index) =>
        run({
          runId: `run-${index}`,
          status: "completed",
          updatedAt: 600 - index,
          workerSessionId: asBrewvaSessionId(`worker-${index}`),
        }),
      ),
      state: {
        mode: "inspecting",
        selectedRunId: "run-5",
        scrollOffset: 0,
      },
    });

    expect(
      selectCompactSubagentFooterTabs({
        tabs: view.tabs,
        selectedRunId: view.selectedRunId,
        maxTabs: 3,
      }).map((tab) => tab.runId),
    ).toEqual(["run-0", "run-1", "run-5"]);
  });
});
