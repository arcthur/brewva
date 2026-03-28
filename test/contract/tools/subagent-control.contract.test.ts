import { describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
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

function buildStatusRuntime(runtime: BrewvaRuntime, store: HostedDelegationStore) {
  const runtimeWithDelegation = Object.create(runtime) as BrewvaRuntime & {
    delegation: {
      listRuns: typeof store.listRuns;
      listPendingOutcomes: typeof store.listPendingOutcomes;
    };
  };
  runtimeWithDelegation.delegation = {
    listRuns: (sessionId, query) => store.listRuns(sessionId, query),
    listPendingOutcomes: (sessionId, query) => store.listPendingOutcomes(sessionId, query),
  };
  return runtimeWithDelegation;
}

describe("subagent control tools", () => {
  test("subagent_status lists persisted delegation runs through the delegation read model", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("subagent-status-runtime"),
    });
    const store = new HostedDelegationStore(runtime);
    runtime.events.record({
      sessionId: "session-status",
      type: "subagent_spawned",
      payload: {
        runId: "run-status-1",
        delegate: "review",
        agentSpec: "review",
        envelope: "readonly-reviewer",
        skillName: "review",
        status: "running",
        kind: "review",
        summary: "Inspecting runtime deltas.",
        modelRoute: {
          selectedModel: "openai/gpt-5.4:medium",
          source: "policy",
          mode: "auto",
          policyId: "review-and-verification",
          requestedModel: "gpt-5.4:medium",
          reason: "Review and verification work should bias toward higher-fidelity reasoning.",
        },
      },
    });

    const tool = createSubagentStatusTool({ runtime: buildStatusRuntime(runtime, store) as any });
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
    expect(extractText(result)).toContain(
      "model: openai/gpt-5.4:medium source=policy mode=auto policy=review-and-verification requested=gpt-5.4:medium",
    );
  });

  test("subagent_status includes replayable handoff metadata for completed runs", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("subagent-status-handoff-runtime"),
    });
    const store = new HostedDelegationStore(runtime);
    runtime.events.record({
      sessionId: "session-status-handoff",
      type: "subagent_completed",
      payload: {
        runId: "run-status-handoff-1",
        delegate: "review",
        status: "completed",
        kind: "review",
        summary: "Review completed and is pending parent surfacing.",
        deliveryMode: "text_only",
        deliveryHandoffState: "pending_parent_turn",
        deliveryReadyAt: 2,
        deliveryUpdatedAt: 3,
      },
    });

    const tool = createSubagentStatusTool({ runtime: buildStatusRuntime(runtime, store) as any });
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
