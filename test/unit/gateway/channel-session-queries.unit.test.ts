import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createTrustedLocalGovernancePort } from "@brewva/brewva-runtime";
import { AgentRegistry } from "../../../packages/brewva-gateway/src/channels/agent-registry.js";
import { AgentRuntimeManager } from "../../../packages/brewva-gateway/src/channels/agent-runtime-manager.js";
import { createChannelSessionQueries } from "../../../packages/brewva-gateway/src/channels/session/queries.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("channel session queries", () => {
  test("given durable channel bindings without a live session, when resolveQuestionSurface runs, then it returns the archived session ids for the target scope", async () => {
    const workspace = createTestWorkspace("channel-session-queries");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    });
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });
    await registry.createAgent({ requestedAgentId: "worker" });
    const runtimeManager = new AgentRuntimeManager({
      controllerRuntime: runtime,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });
    const queries = createChannelSessionQueries({
      runtime,
      registry,
      runtimeManager,
      recoveryWalScope: "channel:test",
      listLiveSessions: () => [],
      openLiveSession: () => undefined,
      loadInspectionRuntime: async () => runtime,
      getSessionCostSummary: () => runtime.inspect.cost.getSummary("agent-session:archived"),
      hasReplayableEffectCommitmentRequest: () => false,
    });

    try {
      runtime.extensions.hosted.events.record({
        sessionId: "agent-session:archived",
        type: "channel_session_bound",
        payload: {
          scopeKey: "scope-a",
          agentId: "worker",
        },
      });
      runtime.extensions.hosted.events.record({
        sessionId: "agent-session:other",
        type: "channel_session_bound",
        payload: {
          scopeKey: "scope-b",
          agentId: "worker",
        },
      });

      const surface = await queries.resolveQuestionSurface("scope-a", "worker");
      expect(surface).toBeDefined();
      expect(surface?.liveSessionId).toBeUndefined();
      expect(surface?.sessionIds).toEqual(["agent-session:archived"]);
    } finally {
      runtimeManager.disposeAll();
      cleanupTestWorkspace(workspace);
    }
  });

  test("given archived bindings without a live runtime, when resolveQuestionSurface runs, then it loads an inspection runtime without consuming the live session map", async () => {
    const workspace = createTestWorkspace("channel-session-queries-no-runtime");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    });
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });
    await registry.createAgent({ requestedAgentId: "worker" });
    const runtimeManager = new AgentRuntimeManager({
      controllerRuntime: runtime,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });
    const queries = createChannelSessionQueries({
      runtime,
      registry,
      runtimeManager,
      recoveryWalScope: "channel:test",
      listLiveSessions: () => [],
      openLiveSession: () => undefined,
      loadInspectionRuntime: async () => runtime,
      getSessionCostSummary: () => runtime.inspect.cost.getSummary("agent-session:archived"),
      hasReplayableEffectCommitmentRequest: () => false,
    });

    try {
      runtime.extensions.hosted.events.record({
        sessionId: "agent-session:archived",
        type: "channel_session_bound",
        payload: {
          scopeKey: "scope-a",
          agentId: "worker",
        },
      });

      const surface = await queries.resolveQuestionSurface("scope-a", "worker");
      expect(surface).toBeDefined();
      expect(surface?.sessionIds).toEqual(["agent-session:archived"]);
    } finally {
      runtimeManager.disposeAll();
      cleanupTestWorkspace(workspace);
    }
  });

  test("given a replayable effect commitment request on a live session, when resolveApprovalTargetAgentId runs, then it routes the approval turn to that agent", async () => {
    const workspace = createTestWorkspace("channel-session-queries-approval");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    });
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });
    await registry.createAgent({ requestedAgentId: "worker" });
    const runtimeManager = new AgentRuntimeManager({
      controllerRuntime: runtime,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });
    const queries = createChannelSessionQueries({
      runtime,
      registry,
      runtimeManager,
      recoveryWalScope: "channel:test",
      listLiveSessions: () => [
        {
          scopeKey: "scope-a",
          agentId: "worker",
          agentSessionId: "agent-session:worker",
        },
      ],
      openLiveSession: () => undefined,
      loadInspectionRuntime: async () => runtime,
      getSessionCostSummary: () => runtime.inspect.cost.getSummary("agent-session:worker"),
      hasReplayableEffectCommitmentRequest: (sessionId, requestId) =>
        sessionId === "agent-session:worker" && requestId === "req-accepted-1",
    });

    try {
      expect(queries.resolveApprovalTargetAgentId("scope-a", "req-accepted-1")).toBe("worker");
    } finally {
      runtimeManager.disposeAll();
      cleanupTestWorkspace(workspace);
    }
  });

  test("given a replayable effect commitment request on an archived bound session, when resolveApprovalTargetAgentIdDurably runs, then it recovers the original agent", async () => {
    const workspace = createTestWorkspace("channel-session-queries-approval-archived");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
    });
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });
    await registry.createAgent({ requestedAgentId: "worker" });
    const runtimeManager = new AgentRuntimeManager({
      controllerRuntime: runtime,
      maxLiveRuntimes: 4,
      idleRuntimeTtlMs: 60_000,
    });
    const queries = createChannelSessionQueries({
      runtime,
      registry,
      runtimeManager,
      recoveryWalScope: "channel:test",
      listLiveSessions: () => [],
      openLiveSession: () => undefined,
      loadInspectionRuntime: async () => runtime,
      getSessionCostSummary: () => runtime.inspect.cost.getSummary("agent-session:archived"),
      hasReplayableEffectCommitmentRequest: () => false,
    });

    try {
      runtime.extensions.hosted.events.record({
        sessionId: "agent-session:archived",
        type: "channel_session_bound",
        payload: {
          scopeKey: "scope-a",
          agentId: "worker",
        },
      });
      Object.assign(runtime.inspect.proposals, {
        listEffectCommitmentRequests: (sessionId: string, query?: { state?: string }) =>
          sessionId === "agent-session:archived" && query?.state === "accepted"
            ? [
                {
                  requestId: "req-accepted-archived",
                  proposalId: "proposal-archived",
                  toolName: "exec",
                  toolCallId: "tc-archived",
                  subject: "tool:exec",
                  boundary: "effectful",
                  effects: ["workspace_write"],
                  argsDigest: "digest-archived",
                  evidenceRefs: [],
                  turn: 1,
                  createdAt: 1,
                  state: "accepted",
                  actor: "operator:test",
                  reason: "approve archived session",
                  updatedAt: 2,
                },
              ]
            : [],
      });

      expect(
        await queries.resolveApprovalTargetAgentIdDurably("scope-a", "req-accepted-archived"),
      ).toBe("worker");
    } finally {
      runtimeManager.disposeAll();
      cleanupTestWorkspace(workspace);
    }
  });
});
