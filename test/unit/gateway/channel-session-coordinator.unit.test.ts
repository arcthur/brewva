import { describe, expect, test } from "bun:test";
import type { HostedSessionResult } from "@brewva/brewva-gateway/hosted";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createDeferred } from "@brewva/brewva-std/async";
import {
  CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE,
  type TurnEnvelope,
} from "@brewva/brewva-vocabulary/wire";
import { AgentRegistry } from "../../../packages/brewva-gateway/src/channels/agent-registry.js";
import { AgentRuntimeManager } from "../../../packages/brewva-gateway/src/channels/agent-runtime-manager.js";
import { createChannelSessionCoordinator } from "../../../packages/brewva-gateway/src/channels/session/coordinator.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import type { HostedRuntimeAdapterPort, BrewvaRuntimeOptions } from "../../helpers/runtime.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createRuntimeInstanceFixture(options);
}

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
  runtime: HostedRuntimeAdapterPort,
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
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "debug";
  const runtime = createHostedTestRuntime({
    cwd: workspace,
    config,
  });
  if (options.captureEvents) {
    runtime.ops.events.records.subscribe((event) => {
      eventRecords.push({
        sessionId: event.sessionId,
        type: event.type,
        payload: event.payload,
      });
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
    createExtensions: () => [],
    sessionOptions: {
      managedToolMode: "direct",
    },
    scopeStrategy: options.scopeStrategy ?? "chat",
    idleRuntimeTtlMs: 60_000,
    recoveryWalScope: "test:channel-recovery-wal",
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
      Object.assign(handle.runtime.ops.proposals.requests, {
        listPending: () => [],
        list: (sessionId: string, query?: { state?: string }) =>
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
      expect(fixture.coordinator.getLiveSession("scope-b", "worker")).toBe(undefined);
      expect(fixture.coordinator.listLiveSessions()).toHaveLength(0);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });

  test("given coordinator-driven cleanup, when a live session is disposed, then a structured session_shutdown receipt is recorded", async () => {
    let fixture: Awaited<ReturnType<typeof createCoordinatorFixture>> | undefined;

    fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      createSession: async () =>
        createHostedSessionResult(
          await fixture!.runtimeManager.getOrCreateRuntime("worker"),
          "agent-session:cleanup",
        ),
    });

    try {
      const handle = await fixture.coordinator.getOrCreateSession(
        "scope-cleanup",
        "worker",
        createUserTurn("scope-cleanup"),
      );

      await fixture.coordinator.cleanupAgentSessions("worker");

      const shutdownEvents = handle.runtime.ops.events.records.query(handle.agentSessionId, {
        type: "session_shutdown",
      });
      expect(shutdownEvents).toHaveLength(1);
      expect(shutdownEvents[0]?.payload).toMatchObject({
        reason: "coordinator_cleanup",
        source: "channel_session_coordinator",
      });
      expect(fixture.coordinator.getLiveSession("scope-cleanup", "worker")).toBe(undefined);
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
        fixture.eventRecords.filter(
          (event) => event.type === CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE,
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });

  test("given a live session receives a newer turn, when representative turn lookup runs, then it returns the latest preserved turn context", async () => {
    let fixture: Awaited<ReturnType<typeof createCoordinatorFixture>> | undefined;

    fixture = await createCoordinatorFixture({
      cleanupGracefulTimeoutMs: 25,
      createSession: async () =>
        createHostedSessionResult(
          await fixture!.runtimeManager.getOrCreateRuntime("worker"),
          "agent-session:representative",
        ),
    });

    try {
      const firstTurn = createUserTurn("scope-representative");
      const handle = await fixture.coordinator.getOrCreateSession(
        "scope-representative",
        "worker",
        firstTurn,
      );
      const secondTurn: TurnEnvelope = {
        ...firstTurn,
        turnId: "turn:scope-representative:latest",
        parts: [{ type: "text", text: "latest" }],
      };

      await fixture.coordinator.getOrCreateSession("scope-representative", "worker", secondTurn);

      expect(
        fixture.coordinator.getRepresentativeTurnByAgentSessionId(handle.agentSessionId)?.turnId,
      ).toBe("turn:scope-representative:latest");
    } finally {
      await fixture.coordinator.disposeAllSessions();
      fixture.coordinator.disposeRuntime("worker");
      cleanupTestWorkspace(fixture.workspace);
    }
  });
});
