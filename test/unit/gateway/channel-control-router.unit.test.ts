import { describe, expect, test } from "bun:test";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-vocabulary/wire";
import type { ChannelCommandMatch } from "../../../packages/brewva-gateway/src/channels/command/parser.js";
import { createChannelControlRouter } from "../../../packages/brewva-gateway/src/channels/command/router.js";
import { createChannelUpdateLockManager } from "../../../packages/brewva-gateway/src/channels/session/update-lock.js";
import { collectOpenSessionQuestions } from "../../../packages/brewva-gateway/src/ingress/internal/operator-questions.js";
import { recordHostedDelegationOutcome } from "../../helpers/events.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

function createUserTurn(text: string, meta?: TurnEnvelope["meta"]): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "channel-session:telegram",
    turnId: "turn-1",
    channel: "telegram",
    conversationId: "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text }],
    meta,
  };
}

function createAclRouterFixture() {
  const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
  const setFocusCalls: Array<{ scopeKey: string; agentId: string }> = [];
  const createdAgents: Array<{ requestedAgentId: string; model?: string }> = [];
  const deletedAgents: string[] = [];
  const fanOutCalls: Array<{ agentIds: readonly string[]; task: string; scopeKey?: string }> = [];
  const discussCalls: Array<{
    agentIds: readonly string[];
    topic: string;
    maxRounds?: number;
    scopeKey?: string;
  }> = [];
  const runtime = createRuntimeFixture();
  const router = createChannelControlRouter({
    runtime,
    registry: {
      resolveFocus: () => "worker",
      isActive: (agentId: string) => agentId !== "inactive",
      setFocus: async (scopeKey: string, agentId: string) => {
        setFocusCalls.push({ scopeKey, agentId });
        return { ok: true, agentId };
      },
      createAgent: async ({
        requestedAgentId,
        model,
      }: {
        requestedAgentId: string;
        model?: string;
      }) => {
        createdAgents.push({ requestedAgentId, model });
        return {
          ok: true,
          agent: {
            agentId: requestedAgentId,
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            model,
          },
        };
      },
      softDeleteAgent: async (agentId: string) => {
        deletedAgents.push(agentId);
        return { ok: true };
      },
    } as never,
    orchestrationConfig: {
      enabled: true,
      owners: { telegram: ["@owner"] },
      aclModeWhenOwnersEmpty: "closed",
    } as never,
    replyWriter: {
      sendControllerReply: async (_turn, _scopeKey, text, meta) => {
        replies.push({ text, meta });
      },
      sendAgentOutputs: async () => 0,
    },
    coordinator: {
      fanOut: async (request) => {
        fanOutCalls.push(request);
        return { ok: true, results: [] };
      },
      discuss: async (request) => {
        discussCalls.push(request);
        return { ok: true, rounds: [], stoppedEarly: false };
      },
    },
    renderAgentsSnapshot: () => "active agents snapshot",
    openLiveSession: () => undefined,
    resolveQuestionSurface: async () => undefined,
    cleanupAgentSessions: async () => undefined,
    disposeAgentRuntime: () => true,
    updateLock: createChannelUpdateLockManager({
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    }),
    updateExecutionScope: {
      lockKey: "workspace-update",
      lockTarget: "workspace",
    },
  });

  return {
    runtime,
    router,
    replies,
    setFocusCalls,
    createdAgents,
    deletedAgents,
    fanOutCalls,
    discussCalls,
  };
}

describe("channel control router ownership", () => {
  test("given an agents command, when handleCommand runs, then the router replies through the controller writer without touching the model path", async () => {
    const replies: string[] = [];
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {} as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text) => {
          replies.push(text);
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const result = await router.handleCommand(
      { kind: "agents" },
      createUserTurn("/agents"),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(replies).toEqual(["active agents snapshot"]);
  });

  test("given a status command, when component handlers return structured meta, then the router preserves section meta in the status reply", async () => {
    const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text, meta) => {
          replies.push({ text, meta });
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
      dependencies: {
        handleQuestionsCommand: async () => ({
          text: "1 pending question",
          meta: { command: "questions", pending: 1 },
        }),
        handleInspectCommand: async () => ({
          text: "Inspect summary",
          meta: { command: "inspect", directory: "src/runtime" },
        }),
        handleInsightsCommand: async () => ({
          text: "Insights summary",
          meta: { command: "insights", analyzedSessions: 2 },
        }),
      },
    });

    const result = await router.handleCommand(
      { kind: "status", directory: "src/runtime", top: 3, details: true },
      createUserTurn("/status src/runtime top=3"),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain("Status @worker");
    expect(replies[0]?.meta).toMatchObject({
      command: "status",
      agentId: "worker",
      top: 3,
      directory: "src/runtime",
      details: true,
      sections: {
        cost: {
          top: 3,
          liveSessionId: null,
        },
        questions: { command: "questions", pending: 1 },
        inspect: { command: "inspect", directory: "src/runtime" },
        insights: { command: "insights", analyzedSessions: 2 },
      },
    });
  });

  test("given a compact status command, when component handlers are available, then the router skips diagnostic sections by default", async () => {
    const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    let inspectCalls = 0;
    let insightsCalls = 0;
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text, meta) => {
          replies.push({ text, meta });
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
      dependencies: {
        handleQuestionsCommand: async () => ({
          text: "No pending questions",
          meta: { command: "questions", pending: 0 },
        }),
        handleInspectCommand: async () => {
          inspectCalls += 1;
          return {
            text: "Inspect summary",
            meta: { command: "inspect" },
          };
        },
        handleInsightsCommand: async () => {
          insightsCalls += 1;
          return {
            text: "Insights summary",
            meta: { command: "insights" },
          };
        },
      },
    });

    const result = await router.handleCommand(
      { kind: "status" },
      createUserTurn("/status"),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(inspectCalls).toBe(0);
    expect(insightsCalls).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain("Status @worker");
    expect(replies[0]?.text).toContain("Cost");
    expect(replies[0]?.text).toContain("Operator input");
    expect(replies[0]?.text).not.toContain("Inspect");
    expect(replies[0]?.text).not.toContain("Insights");
    expect(replies[0]?.meta).toMatchObject({
      command: "status",
      details: false,
      sections: {
        cost: {
          top: 5,
          liveSessionId: null,
        },
        questions: { command: "questions", pending: 0 },
      },
    });
    expect(replies[0]?.meta?.sections).not.toHaveProperty("inspect");
    expect(replies[0]?.meta?.sections).not.toHaveProperty("insights");
  });

  test("given a mention from a non-owner, when the router routes it, then it does not persist workspace focus", async () => {
    const fixture = createAclRouterFixture();

    const result = await fixture.router.handleCommand(
      { kind: "route-agent", agentId: "worker-2", task: "review this", viaMention: true },
      createUserTurn("@worker-2 review this", { senderUsername: "guest" }),
      "scope-1",
    );

    expect(result).toEqual({
      handled: false,
      routeAgentId: "worker-2",
      routeTask: "review this",
    });
    expect(fixture.setFocusCalls).toEqual([]);
  });

  test("given a mention from an owner, when the router routes it, then it persists workspace focus", async () => {
    const fixture = createAclRouterFixture();

    const result = await fixture.router.handleCommand(
      { kind: "route-agent", agentId: "worker-2", task: "review this", viaMention: true },
      createUserTurn("@worker-2 review this", { senderUsername: "owner" }),
      "scope-1",
    );

    expect(result).toEqual({
      handled: false,
      routeAgentId: "worker-2",
      routeTask: "review this",
    });
    expect(fixture.setFocusCalls).toEqual([{ scopeKey: "scope-1", agentId: "worker-2" }]);
  });

  test("given a mention for an inactive agent, when the router handles it, then it replies inline and does not reroute", async () => {
    const fixture = createAclRouterFixture();

    const result = await fixture.router.handleCommand(
      { kind: "route-agent", agentId: "inactive", task: "review this", viaMention: true },
      createUserTurn("@inactive review this", { senderUsername: "owner" }),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(fixture.replies.at(-1)?.text).toBe(
      "Mention unavailable: agent @inactive is not active in this workspace.",
    );
    expect(fixture.setFocusCalls).toEqual([]);
  });

  test("given owner-only commands from a non-owner, when the router handles them, then it denies them before side effects", async () => {
    const fixture = createAclRouterFixture();
    const deniedTurn = createUserTurn("/status", { senderUsername: "guest" });
    const matches: ChannelCommandMatch[] = [
      { kind: "status" },
      { kind: "focus", agentId: "worker-2" },
      { kind: "run", agentIds: ["worker", "worker-2"], task: "review this" },
      {
        kind: "discuss",
        agentIds: ["worker", "worker-2"],
        topic: "design this",
        maxRounds: 2,
      },
      { kind: "agent-create", agentId: "worker-2", model: "openai/gpt-5.3-codex" },
      { kind: "agent-delete", agentId: "worker-2" },
    ];

    for (const match of matches) {
      const result = await fixture.router.handleCommand(match, deniedTurn, "scope-1");
      expect(result).toEqual({ handled: true });
    }

    expect(fixture.replies).toHaveLength(matches.length);
    for (const reply of fixture.replies) {
      expect(reply.text).toBe("Command denied: owner permission required.");
    }
    expect(fixture.setFocusCalls).toEqual([]);
    expect(fixture.createdAgents).toEqual([]);
    expect(fixture.deletedAgents).toEqual([]);
    expect(fixture.fanOutCalls).toEqual([]);
    expect(fixture.discussCalls).toEqual([]);
  });

  test("given a status command for an inactive agent, when handleCommand runs, then the router returns a handled not-active reply", async () => {
    const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: (agentId: string) => agentId !== "inactive",
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text, meta) => {
          replies.push({ text, meta });
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const result = await router.handleCommand(
      { kind: "status", agentId: "inactive" },
      createUserTurn("/status @inactive"),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(replies).toEqual([
      {
        text: "Status unavailable: agent @inactive is not active in this workspace.",
        meta: {
          command: "status",
          agentId: "inactive",
          status: "agent_not_active",
        },
      },
    ]);
  });

  test("given a status dependency failure, when handleCommand runs, then the router degrades that section explicitly instead of throwing", async () => {
    const replies: Array<{ text: string; meta?: Record<string, unknown> }> = [];
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text, meta) => {
          replies.push({ text, meta });
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
      dependencies: {
        handleQuestionsCommand: async () => ({
          text: "No pending questions",
          meta: { command: "questions", pending: 0 },
        }),
        handleInspectCommand: async () => {
          throw new Error("inspect exploded");
        },
        handleInsightsCommand: async () => ({
          text: "Insights summary",
          meta: { command: "insights", analyzedSessions: 2 },
        }),
      },
    });

    const result = await router.handleCommand(
      { kind: "status", details: true },
      createUserTurn("/status"),
      "scope-1",
    );

    expect(result).toEqual({ handled: true });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain(
      "Inspect unavailable: failed to build the inspect summary for @worker (inspect exploded).",
    );
    expect(replies[0]?.meta).toMatchObject({
      command: "status",
      details: true,
      sections: {
        questions: { command: "questions", pending: 0 },
        inspect: { command: "inspect", status: "dependency_failed" },
        insights: { command: "insights", analyzedSessions: 2 },
      },
    });
  });

  test("given a duplicate update request, when prepareCommand runs, then the router owns the blocked reply and lock event path before queue dispatch", async () => {
    const replies: string[] = [];
    const router = createChannelControlRouter({
      runtime: createRuntimeFixture(),
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text) => {
          replies.push(text);
        },
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => undefined,
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const first = await router.prepareCommand(
      { kind: "update", instructions: "target=latest" },
      createUserTurn("/update target=latest"),
      "scope-1",
    );
    const second = await router.prepareCommand(
      { kind: "update", instructions: "target=latest" },
      {
        ...createUserTurn("/update target=latest"),
        turnId: "turn-2",
      },
      "scope-2",
    );

    expect(first.handled).toBe(false);
    expect(typeof first.release).toBe("function");
    expect(second).toEqual({
      match: { kind: "update", instructions: "target=latest" },
      handled: true,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Update already in progress");

    first.release?.();
  });

  test("given an answer command, when the router builds a routed task, then it defers the answer receipt until the post-success callback runs", async () => {
    const runtime = createRuntimeFixture();
    const sessionId = "agent-session:worker";

    recordHostedDelegationOutcome({
      runtime,
      sessionId,
      runId: "router-answer-question-1",
      payload: {
        delegate: "explorer",
        kind: "consult",
        consultKind: "review",
      },
      outcome: {
        ok: true,
        runId: "router-answer-question-1",
        delegate: "explorer",
        label: "explorer",
        kind: "consult",
        consultKind: "review",
        status: "ok",
        summary: "Open question available.",
        data: {
          kind: "consult",
          consultKind: "review",
          conclusion: "The run needs operator input.",
          followUpQuestions: ["Which deployment target should the gateway use?"],
        },
        metrics: { durationMs: 1 },
        evidenceRefs: [],
      },
    });

    const collection = await collectOpenSessionQuestions(runtime, sessionId);
    const questionId = collection.questions[0]?.questionId;
    expect(typeof questionId).toBe("string");
    expect(questionId?.length).toBeGreaterThan(0);

    const router = createChannelControlRouter({
      runtime,
      registry: {
        resolveFocus: () => "worker",
        isActive: () => true,
      } as never,
      orchestrationConfig: {
        enabled: true,
        owners: { telegram: [] },
        aclModeWhenOwnersEmpty: "open",
      } as never,
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      coordinator: {
        fanOut: async () => ({ ok: true, results: [] }),
        discuss: async () => ({ ok: true, rounds: [], stoppedEarly: false }),
      },
      renderAgentsSnapshot: () => "active agents snapshot",
      openLiveSession: () => undefined,
      resolveQuestionSurface: async () => ({
        runtime,
        sessionIds: [sessionId],
      }),
      cleanupAgentSessions: async () => undefined,
      disposeAgentRuntime: () => true,
      updateLock: createChannelUpdateLockManager({
        updateExecutionScope: {
          lockKey: "workspace-update",
          lockTarget: "workspace",
        },
      }),
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const result = await router.handleCommand(
      {
        kind: "answer",
        questionId: questionId!,
        answerText: "Use the daemon path.",
      },
      createUserTurn(`/answer ${questionId!} Use the daemon path.`),
      "scope-1",
    );

    expect(result.handled).toBe(false);
    expect(result.routeTask).toContain("Use the daemon path.");
    expect(result.afterRouteSuccess).toBeFunction();
    expect(
      runtime.ops.events.records.query(sessionId, {
        type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
      }),
    ).toHaveLength(0);

    await result.afterRouteSuccess?.();

    expect(
      runtime.ops.events.records.query(sessionId, {
        type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
  });
});
