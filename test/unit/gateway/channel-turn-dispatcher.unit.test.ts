import { describe, expect, test } from "bun:test";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { type RecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { createChannelTurnDispatcher } from "../../../packages/brewva-gateway/src/channels/channel-turn-dispatcher.js";
import { CommandRouter } from "../../../packages/brewva-gateway/src/channels/command/parser.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

function createUserTurn(
  text: string,
  options: {
    turnId?: string;
    conversationId?: string;
  } = {},
): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "channel-session:telegram",
    turnId: options.turnId ?? "turn-1",
    channel: "telegram",
    conversationId: options.conversationId ?? "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text }],
  };
}

function createRecoveryWalStoreStub(): RecoveryWalStore {
  return {
    appendPending: () => ({ walId: "wal-1" }),
    markInflight: () => undefined,
    markDone: () => undefined,
    markFailed: () => undefined,
  } as unknown as RecoveryWalStore;
}

describe("channel turn dispatcher ingress routing", () => {
  test("given a user mention route, when the dispatcher enqueues the turn, then it routes the rewritten task to the target agent", async () => {
    const routed: Array<{ agentId: string; text: string }> = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: createRecoveryWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => undefined,
      processUserTurnOnAgent: async (turn, _walId, _scopeKey, targetAgentId) => {
        const text = turn.parts[0]?.type === "text" ? turn.parts[0].text : "";
        routed.push({ agentId: targetAgentId, text });
      },
      handleCommand: async (match) =>
        match.kind === "route-agent"
          ? {
              handled: false,
              routeAgentId: match.agentId,
              routeTask: match.task,
            }
          : { handled: false },
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    await dispatcher.enqueueInboundTurn(createUserTurn("@reviewer run the release checklist"), {
      awaitCompletion: true,
    });

    expect(routed).toEqual([{ agentId: "reviewer", text: "run the release checklist" }]);
  });

  test("given an approval turn with a resolved approval target, when the dispatcher enqueues it, then it prefers the approval target agent", async () => {
    const routed: string[] = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: createRecoveryWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => "approver",
      processUserTurnOnAgent: async (_turn, _walId, _scopeKey, targetAgentId) => {
        routed.push(targetAgentId);
      },
      handleCommand: async () => ({ handled: false }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    const approvalTurn: TurnEnvelope = {
      ...createUserTurn("approve"),
      kind: "approval",
      approval: {
        requestId: "approval-1",
        title: "Approve effect",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };

    await dispatcher.enqueueInboundTurn(approvalTurn, { awaitCompletion: true });

    expect(routed).toEqual(["approver"]);
  });

  test("given many scopes, when last-turn cache exceeds capacity, then least recently used scopes are evicted", async () => {
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: createRecoveryWalStoreStub(),
      orchestrationEnabled: false,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: (turn) => turn.conversationId,
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => undefined,
      processUserTurnOnAgent: async () => undefined,
      handleCommand: async () => ({ handled: false }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
      lastTurnCacheMaxEntries: 2,
    });

    await dispatcher.enqueueInboundTurn(
      createUserTurn("scope a", {
        turnId: "turn-a",
        conversationId: "scope-a",
      }),
      { awaitCompletion: true },
    );
    await dispatcher.enqueueInboundTurn(
      createUserTurn("scope b", {
        turnId: "turn-b",
        conversationId: "scope-b",
      }),
      { awaitCompletion: true },
    );

    expect(dispatcher.getLastTurn("scope-a")?.turnId).toBe("turn-a");

    await dispatcher.enqueueInboundTurn(
      createUserTurn("scope c", {
        turnId: "turn-c",
        conversationId: "scope-c",
      }),
      { awaitCompletion: true },
    );

    expect(dispatcher.getLastTurn("scope-b")).toBeUndefined();
    expect(dispatcher.getLastTurn("scope-a")?.turnId).toBe("turn-a");
    expect(dispatcher.getLastTurn("scope-c")?.turnId).toBe("turn-c");
  });

  test("given a routed command with a deferred receipt, when the routed turn succeeds, then the dispatcher records the receipt after the agent turn", async () => {
    const steps: string[] = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: {
        appendPending: () => ({ walId: "wal-1" }),
        markInflight: () => {
          steps.push("inflight");
        },
        markDone: () => {
          steps.push("done");
        },
        markFailed: () => {
          steps.push("failed");
        },
      } as unknown as RecoveryWalStore,
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: {
        match: () => ({ kind: "status" }),
      } as never,
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => undefined,
      processUserTurnOnAgent: async (turn) => {
        steps.push(`process:${turn.parts[0]?.type === "text" ? turn.parts[0].text : "unknown"}`);
      },
      handleCommand: async () => ({
        handled: false,
        routeAgentId: "reviewer",
        routeTask: "Use the operator answer and continue.",
        afterRouteSuccess: () => {
          steps.push("receipt");
        },
      }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    await dispatcher.enqueueInboundTurn(createUserTurn("/status"), {
      awaitCompletion: true,
    });

    expect(steps).toEqual([
      "inflight",
      "process:Use the operator answer and continue.",
      "receipt",
      "done",
    ]);
  });

  test("given a routed command with a deferred receipt, when the routed turn fails, then the dispatcher does not record the receipt", async () => {
    const steps: string[] = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: {
        appendPending: () => ({ walId: "wal-1" }),
        markInflight: () => {
          steps.push("inflight");
        },
        markDone: () => {
          steps.push("done");
        },
        markFailed: () => {
          steps.push("failed");
        },
      } as unknown as RecoveryWalStore,
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: {
        match: () => ({ kind: "status" }),
      } as never,
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => undefined,
      processUserTurnOnAgent: async () => {
        steps.push("process");
        throw new Error("route failed");
      },
      handleCommand: async () => ({
        handled: false,
        routeAgentId: "reviewer",
        routeTask: "Use the operator answer and continue.",
        afterRouteSuccess: () => {
          steps.push("receipt");
        },
      }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    let caught: unknown;
    try {
      await dispatcher.enqueueInboundTurn(createUserTurn("/status"), {
        awaitCompletion: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("route failed");
    expect(steps).toEqual(["inflight", "process", "failed"]);
  });

  test("given an approval turn without a live target, when the durable approval resolver finds the archived agent, then dispatch routes to that agent", async () => {
    const routed: string[] = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: createRecoveryWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => "approver",
      processUserTurnOnAgent: async (_turn, _walId, _scopeKey, targetAgentId) => {
        routed.push(targetAgentId);
      },
      handleCommand: async () => ({ handled: false }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    const approvalTurn: TurnEnvelope = {
      ...createUserTurn("approve"),
      kind: "approval",
      approval: {
        requestId: "approval-archived",
        title: "Approve effect",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };

    await dispatcher.enqueueInboundTurn(approvalTurn, { awaitCompletion: true });

    expect(routed).toEqual(["approver"]);
  });

  test("given an approval turn without any live or durable target, when the dispatcher processes it, then it does not fall back to the focused agent", async () => {
    const replies: string[] = [];
    const routed: string[] = [];
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      recoveryWalStore: createRecoveryWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async (_turn, _scopeKey, text) => {
          replies.push(text);
        },
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      resolveApprovalTargetAgentIdDurably: async () => undefined,
      processUserTurnOnAgent: async (_turn, _walId, _scopeKey, targetAgentId) => {
        routed.push(targetAgentId);
      },
      handleCommand: async () => ({ handled: false }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    const approvalTurn: TurnEnvelope = {
      ...createUserTurn("approve"),
      kind: "approval",
      approval: {
        requestId: "approval-missing",
        title: "Approve effect",
        actions: [{ id: "approve", label: "Approve" }],
      },
    };

    await dispatcher.enqueueInboundTurn(approvalTurn, { awaitCompletion: true });

    expect(routed).toEqual([]);
    expect(replies).toEqual(["Approval request is no longer active for this workspace."]);
  });
});
