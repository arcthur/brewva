import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createSubagentCancelTool,
  createSubagentStatusTool,
  type SubagentRunRequest,
} from "@brewva/brewva-tools";
import { createTestWorkspace } from "../../helpers/workspace.js";

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (
    result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text ??
    ""
  );
}

describe("subagent control tools", () => {
  test("subagent_status lists persisted delegation runs through the runtime facade", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("subagent-status-runtime"),
    });
    runtime.session.recordDelegationRun("session-status", {
      runId: "run-status-1",
      delegate: "review",
      agentSpec: "review",
      envelope: "readonly-reviewer",
      skillName: "review",
      parentSessionId: "session-status",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      kind: "review",
      summary: "Inspecting runtime deltas.",
    });

    const tool = createSubagentStatusTool({ runtime });
    const result = await tool.execute(
      "tc-subagent-status",
      {},
      undefined,
      undefined,
      fakeContext("session-status"),
    );

    expect(extractText(result)).toContain("# Subagent Status");
    expect(extractText(result)).toContain("run-status-1");
    expect(extractText(result)).toContain("status=running");
    expect(extractText(result)).toContain(
      "delegate: agentSpec=review envelope=readonly-reviewer delegatedSkill=review",
    );
  });

  test("subagent_status includes replayable handoff metadata for completed runs", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("subagent-status-handoff-runtime"),
    });
    runtime.session.recordDelegationRun("session-status-handoff", {
      runId: "run-status-handoff-1",
      delegate: "review",
      parentSessionId: "session-status-handoff",
      status: "completed",
      createdAt: 1,
      updatedAt: 3,
      kind: "review",
      summary: "Review completed and is pending parent surfacing.",
      delivery: {
        mode: "text_only",
        handoffState: "pending_parent_turn",
        readyAt: 2,
        updatedAt: 3,
      },
    });

    const tool = createSubagentStatusTool({ runtime });
    const result = await tool.execute(
      "tc-subagent-status-handoff",
      {},
      undefined,
      undefined,
      fakeContext("session-status-handoff"),
    );

    expect(extractText(result)).toContain("run-status-handoff-1");
    expect(extractText(result)).toContain("delivery: mode=text_only handoff=pending_parent_turn");
  });

  test("subagent_cancel delegates cancellation to the orchestration adapter", async () => {
    const tool = createSubagentCancelTool({
      runtime: {
        orchestration: {
          subagents: {
            run: async (_input: { fromSessionId: string; request: SubagentRunRequest }) => ({
              ok: true,
              mode: "single",
              delegate: "explore",
              outcomes: [],
            }),
            cancel: async (input: { fromSessionId: string; runId: string; reason?: string }) => ({
              ok: true,
              run: {
                runId: input.runId,
                delegate: "explore",
                parentSessionId: input.fromSessionId,
                status: "cancelled" as const,
                createdAt: 1,
                updatedAt: 2,
                summary: input.reason ?? "cancelled",
              },
            }),
          },
        },
      } as any,
    });

    const result = await tool.execute(
      "tc-subagent-cancel",
      {
        runId: "run-cancel-1",
        reason: "manual_stop",
      },
      undefined,
      undefined,
      fakeContext("session-cancel"),
    );

    expect(extractText(result)).toContain("Subagent cancelled.");
    expect(extractText(result)).toContain("run-cancel-1");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });
});
