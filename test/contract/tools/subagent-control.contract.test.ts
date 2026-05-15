import { describe, expect, test } from "bun:test";
import { HostedDelegationStore } from "@brewva/brewva-gateway";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort, BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/delegation";
import type { SubagentRunRequest } from "@brewva/brewva-tools/contracts";
import {
  createSubagentCancelTool,
  createSubagentStatusTool,
} from "@brewva/brewva-tools/delegation";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

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

function buildStatusRuntime(runtime: BrewvaHostedRuntimePort, store: HostedDelegationStore) {
  const runtimeWithDelegation = Object.create(runtime) as BrewvaHostedRuntimePort & {
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
    const runtime = createHostedTestRuntime({
      cwd: createTestWorkspace("subagent-status-runtime"),
    });
    const store = new HostedDelegationStore(runtime);
    runtime.extensions.hosted.events.record({
      sessionId: "session-status",
      type: "subagent_spawned",
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: "run-status-1",
        agent: "explorer",
        targetName: "explorer",
        taskName: "review-runtime-deltas",
        taskPath: "/review-runtime-deltas",
        nickname: "review runtime deltas",
        depth: 1,
        forkTurns: "none",
        gateReason: "make_judgment",
        modelCategory: "deep-reasoning",
        delegate: "explorer",
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        adoption: {
          contractId: "status-test",
          decision: "require_human",
          reason: "Fixture record has not reached parent adoption.",
        },
        agentSpec: "explorer",
        envelope: "explorer-readonly",
        skillName: "review",
        status: "running",
        kind: "consult",
        consultKind: "review",
        summary: "Inspecting runtime deltas.",
        modelRoute: {
          selectedModel: "openai/gpt-5.4:medium",
          category: "deep-reasoning",
          source: "policy",
          mode: "auto",
          policyId: "review-and-verification",
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
    expect(extractText(result)).toContain("review runtime deltas");
    expect(extractText(result)).toContain("path=/review-runtime-deltas");
    expect(extractText(result)).toContain("status=running");
    expect(extractText(result)).toContain("adoption: decision=require_human");
    expect(extractText(result)).not.toContain("agentSpec=explorer");
    expect(extractText(result)).not.toContain("envelope=explorer-readonly");
    expect(extractText(result)).not.toContain("delegatedSkill=review");
    expect(extractText(result)).not.toContain("model: openai/gpt-5.4:medium");
    expect(JSON.stringify(result.details)).not.toContain("agentSpec");
    expect(JSON.stringify(result.details)).not.toContain("explorer-readonly");
    expect(JSON.stringify(result.details)).not.toContain("consultKind");

    const diagnosticResult = await tool.execute(
      "tc-subagent-status-diagnostic",
      { detailMode: "diagnostic" },
      undefined,
      undefined,
      fakeContext("session-status"),
    );
    expect(extractText(diagnosticResult)).toContain(
      "delegate: agentSpec=explorer envelope=explorer-readonly delegatedSkill=review consultKind=review",
    );
    expect(extractText(diagnosticResult)).toContain(
      "model: openai/gpt-5.4:medium category=deep-reasoning source=policy mode=auto policy=review-and-verification",
    );
  });

  test("subagent_status includes replayable handoff metadata for completed runs", async () => {
    const runtime = createHostedTestRuntime({
      cwd: createTestWorkspace("subagent-status-handoff-runtime"),
    });
    const store = new HostedDelegationStore(runtime);
    runtime.extensions.hosted.events.record({
      sessionId: "session-status-handoff",
      type: "subagent_completed",
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: "run-status-handoff-1",
        agent: "explorer",
        targetName: "explorer",
        taskName: "review-handoff",
        taskPath: "/review-handoff",
        nickname: "review handoff",
        depth: 1,
        forkTurns: "none",
        gateReason: "make_judgment",
        modelCategory: "deep-reasoning",
        delegate: "explorer",
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        adoption: {
          contractId: "status-test",
          decision: "require_human",
          reason: "Fixture record has not reached parent adoption.",
        },
        status: "completed",
        kind: "consult",
        consultKind: "review",
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

    expect(extractText(result)).toContain("review handoff");
    expect(extractText(result)).toContain("path=/review-handoff");
    expect(extractText(result)).toContain("delivery: mode=text_only handoff=pending_parent_turn");
  });

  test("subagent_status folds internal lanes by default and exposes them in internal detail mode", async () => {
    const runtime = createHostedTestRuntime({
      cwd: createTestWorkspace("subagent-status-detail-mode-runtime"),
    });
    const store = new HostedDelegationStore(runtime);
    runtime.extensions.hosted.events.record({
      sessionId: "session-status-detail-mode",
      type: "subagent_completed",
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: "run-public",
        agent: "explorer",
        targetName: "explorer",
        taskName: "public-review",
        taskPath: "/public-review",
        nickname: "public review",
        depth: 1,
        forkTurns: "none",
        gateReason: "make_judgment",
        modelCategory: "deep-reasoning",
        delegate: "explorer",
        executionPrimitive: "named",
        visibility: "public",
        isolationStrategy: "shared",
        adoption: {
          contractId: "status-test",
          decision: "require_human",
          reason: "Fixture record has not reached parent adoption.",
        },
        status: "completed",
        kind: "consult",
        consultKind: "review",
        summary: "Public review summary.",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId: "session-status-detail-mode",
      type: "subagent_completed",
      payload: {
        contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
        runId: "run-internal-lane",
        agent: "explorer",
        targetName: "review-security",
        taskName: "security-review",
        taskPath: "/security-review",
        nickname: "security review",
        depth: 1,
        forkTurns: "none",
        gateReason: "make_judgment",
        modelCategory: "deep-reasoning",
        delegate: "review-security",
        agentSpec: "review-security",
        executionPrimitive: "named",
        visibility: "internal",
        isolationStrategy: "shared",
        adoption: {
          contractId: "status-test",
          decision: "require_human",
          reason: "Fixture record has not reached parent adoption.",
        },
        status: "completed",
        kind: "consult",
        consultKind: "review",
        summary: "Internal lane summary.",
      },
    });

    const tool = createSubagentStatusTool({ runtime: buildStatusRuntime(runtime, store) as any });
    const publicResult = await tool.execute(
      "tc-subagent-status-public-detail",
      {},
      undefined,
      undefined,
      fakeContext("session-status-detail-mode"),
    );
    const internalResult = await tool.execute(
      "tc-subagent-status-internal-detail",
      { detailMode: "internal" },
      undefined,
      undefined,
      fakeContext("session-status-detail-mode"),
    );

    expect(extractText(publicResult)).toContain("public review");
    expect(extractText(publicResult)).toContain("path=/public-review");
    expect(extractText(publicResult)).not.toContain("run-internal-lane");
    expect(extractText(publicResult)).toContain("hidden internal/diagnostic runs=1");
    expect(extractText(internalResult)).toContain("security review");
    expect(extractText(internalResult)).toContain("path=/security-review");
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
                contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
                runId: input.runId,
                agent: "explorer" as const,
                targetName: "explorer",
                taskName: "explore",
                taskPath: "/explore",
                nickname: "explore",
                depth: 1,
                forkTurns: "none" as const,
                gateReason: "make_judgment" as const,
                modelCategory: "deep-reasoning" as const,
                delegate: "explore",
                executionPrimitive: "named" as const,
                visibility: "public" as const,
                isolationStrategy: "shared" as const,
                adoption: {
                  contractId: "subagent-cancel-test",
                  decision: "require_human" as const,
                  reason: "Fixture record has not reached parent adoption.",
                },
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
    expect(extractText(result)).toContain("explore");
    expect(extractText(result)).toContain("path=/explore");
    expect((result.details as { ok?: boolean } | undefined)?.ok).toBe(true);
  });
});
