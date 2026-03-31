import { describe, expect, test } from "bun:test";
import { BrewvaRuntime, createTrustedLocalGovernancePort } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { AgentRegistry } from "../../../packages/brewva-gateway/src/channels/agent-registry.js";
import { AgentRuntimeManager } from "../../../packages/brewva-gateway/src/channels/agent-runtime-manager.js";
import { createChannelSessionCoordinator } from "../../../packages/brewva-gateway/src/channels/channel-session-coordinator.js";
import type { HostedSessionResult } from "../../../packages/brewva-gateway/src/host/create-hosted-session.js";
import { createDeferred } from "../../../packages/brewva-gateway/src/utils/deferred.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createUserTurn(scopeKey: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: `channel-session:${scopeKey}`,
    turnId: `turn:${scopeKey}`,
    channel: "telegram",
    conversationId: scopeKey,
    timestamp: Date.now(),
    parts: [{ type: "text", text: "hello" }],
  };
}

function createHostedSessionResult(
  runtime: BrewvaRuntime,
  sessionId: string,
  hooks: {
    abort?: () => Promise<void>;
    dispose?: () => void;
  } = {},
): HostedSessionResult {
  return {
    runtime,
    session: {
      abort: hooks.abort ?? (async () => undefined),
      dispose: hooks.dispose ?? (() => undefined),
      sessionManager: {
        getSessionId: () => sessionId,
      },
    },
  } as unknown as HostedSessionResult;
}

async function createCoordinatorFixture(options: {
  createSession: (input?: unknown) => Promise<HostedSessionResult>;
  cleanupGracefulTimeoutMs: number;
  captureEvents?: boolean;
  scopeStrategy?: "chat" | "thread";
}): Promise<{
  workspace: string;
  registry: AgentRegistry;
  runtimeManager: AgentRuntimeManager;
  eventRecords: { sessionId: string; type: string; payload?: unknown }[];
  coordinator: ReturnType<typeof createChannelSessionCoordinator>;
}> {
  const workspace = createTestWorkspace("channel-session-coordinator");
  const eventRecords: { sessionId: string; type: string; payload?: unknown }[] = [];
  const runtime = new BrewvaRuntime({
    cwd: workspace,
    governancePort: createTrustedLocalGovernancePort({ profile: "team" }),
  });
  if (options.captureEvents) {
    Object.assign(runtime.events, {
      record: (event: { sessionId: string; type: string; payload?: unknown }) => {
        eventRecords.push(event);
      },
    });
  }
  const registry = await AgentRegistry.create({ workspaceRoot: workspace });
  await registry.createAgent({ requestedAgentId: "worker" });
  const runtimeManager = new AgentRuntimeManager({
    controllerRuntime: runtime,
    maxLiveRuntimes: 4,
    idleRuntimeTtlMs: 60_000,
  });
  const coordinator = createChannelSessionCoordinator({
    runtime,
    registry,
    runtimeManager,
    createSession: options.createSession as Parameters<
      typeof createChannelSessionCoordinator
    >[0]["createSession"],
    createRuntimePlugins: () => [],
    sessionOptions: {
      managedToolMode: "direct",
    },
    scopeStrategy: options.scopeStrategy ?? "chat",
    idleRuntimeTtlMs: 60_000,
    turnWalScope: "test:channel-turn-wal",
    cleanupGracefulTimeoutMs: options.cleanupGracefulTimeoutMs,
  });
  return {
    workspace,
    registry,
    runtimeManager,
    eventRecords,
    coordinator,
  };
}

describe("channel session coordinator ownership", () => {
  test("given an accepted effect commitment request, when replayable request lookup runs, then accepted requests remain discoverable after leaving the pending queue", async () => {
    let fixture: Awaited<ReturnType<typeof createCoordinatorFixture>> | undefined;

    fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      createSession: async () =>
        createHostedSessionResult(
          await fixture!.runtimeManager.getOrCreateRuntime("worker"),
          "agent-session:approval",
        ),
    });

    try {
      const handle = await fixture.coordinator.getOrCreateSession(
        "scope-approval",
        "worker",
        createUserTurn("scope-approval"),
      );

      const requestId = "req-accepted-1";
      Object.assign(handle.runtime.proposals, {
        listPendingEffectCommitments: () => [],
        listEffectCommitmentRequests: (sessionId: string, query?: { state?: string }) =>
          sessionId === handle.agentSessionId && query?.state === "accepted"
            ? [
                {
                  requestId,
                  proposalId: "proposal-1",
                  toolName: "exec",
                  toolCallId: "tc-exec-coordinator-approval",
                  subject: "tool:exec",
                  boundary: "effectful",
                  effects: ["workspace_write"],
                  argsDigest: "digest-1",
                  evidenceRefs: [],
                  turn: 1,
                  createdAt: 1,
                  state: "accepted",
                  actor: "operator:test",
                  reason: "safe local command",
                  updatedAt: 2,
                },
              ]
            : [],
      });

      expect(fixture.coordinator.hasPendingEffectCommitment(handle.agentSessionId, requestId)).toBe(
        false,
      );
      expect(
        fixture.coordinator.hasReplayableEffectCommitmentRequest(handle.agentSessionId, requestId),
      ).toBe(true);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });

  test("given pending create exceeds cleanup grace timeout, when cleanupAgentSessions runs, then it returns without waiting forever and stale create cannot publish", async () => {
    const createStarted = createDeferred<void>();
    const createDeferredResult = createDeferred<HostedSessionResult>();
    let fixture: Awaited<ReturnType<typeof createCoordinatorFixture>> | undefined;
    let createCalls = 0;
    let disposeCalls = 0;

    fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      createSession: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          createStarted.resolve();
          return await createDeferredResult.promise;
        }
        const freshRuntime = await fixture!.runtimeManager.getOrCreateRuntime("worker");
        return createHostedSessionResult(freshRuntime, "agent-session:fresh");
      },
    });

    try {
      const pendingSession = fixture.coordinator.getOrCreateSession(
        "scope-a",
        "worker",
        createUserTurn("scope-a"),
      );
      await createStarted.promise;

      const startedAt = Date.now();
      await fixture.coordinator.cleanupAgentSessions("worker");
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(250);

      const staleRuntime = await fixture.runtimeManager.getOrCreateRuntime("worker");
      createDeferredResult.resolve(
        createHostedSessionResult(staleRuntime, "agent-session:stale", {
          dispose: () => {
            disposeCalls += 1;
          },
        }),
      );

      const freshSession = await pendingSession;
      expect(disposeCalls).toBe(1);
      expect(freshSession.agentSessionId).not.toBe("agent-session:stale");
      expect(fixture.coordinator.getLiveSession("scope-a", "worker")?.agentSessionId).toBe(
        freshSession.agentSessionId,
      );
      expect(fixture.coordinator.listLiveSessions()).toHaveLength(1);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });

  test("given agent is soft-deleted during an in-flight create, when the create resolves, then no live session is published and future creates are rejected", async () => {
    const createStarted = createDeferred<void>();
    const createDeferredResult = createDeferred<HostedSessionResult>();
    let disposeCalls = 0;

    const fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      createSession: async () => {
        createStarted.resolve();
        return await createDeferredResult.promise;
      },
    });

    try {
      const pendingSession = fixture.coordinator.getOrCreateSession(
        "scope-b",
        "worker",
        createUserTurn("scope-b"),
      );
      await createStarted.promise;

      await fixture.registry.softDeleteAgent("worker");
      await fixture.coordinator.cleanupAgentSessions("worker");

      const workerRuntime = await fixture.runtimeManager.getOrCreateRuntime("worker");
      createDeferredResult.resolve(
        createHostedSessionResult(workerRuntime, "agent-session:deleted", {
          dispose: () => {
            disposeCalls += 1;
          },
        }),
      );

      expect(pendingSession).rejects.toThrow("agent_not_found:worker");
      expect(
        fixture.coordinator.getOrCreateSession("scope-b", "worker", createUserTurn("scope-b")),
      ).rejects.toThrow("agent_not_found:worker");
      expect(disposeCalls).toBe(1);
      expect(fixture.coordinator.getLiveSession("scope-b", "worker")).toBeUndefined();
      expect(fixture.coordinator.listLiveSessions()).toHaveLength(0);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });

  test("given a new conversation turn, when resolveScopeKey runs repeatedly, then the coordinator owns binding persistence and emits a single binding event", async () => {
    const fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      captureEvents: true,
      createSession: async () => {
        throw new Error("createSession should not run in scope resolution test");
      },
    });

    try {
      const firstTurn = createUserTurn("scope-c");
      const secondTurn = {
        ...firstTurn,
        turnId: "turn:scope-c:2",
      };

      const firstScopeKey = fixture.coordinator.resolveScopeKey(firstTurn);
      const secondScopeKey = fixture.coordinator.resolveScopeKey(secondTurn);

      expect(firstScopeKey).toBe("telegram:scope-c");
      expect(secondScopeKey).toBe(firstScopeKey);
      expect(
        fixture.eventRecords.filter((event) => event.type === "channel_conversation_bound"),
      ).toHaveLength(1);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });
});
