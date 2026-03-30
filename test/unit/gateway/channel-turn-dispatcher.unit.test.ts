import { describe, expect, test } from "bun:test";
import type { TurnEnvelope, TurnWALStore } from "@brewva/brewva-runtime/channels";
import { createChannelTurnDispatcher } from "../../../packages/brewva-gateway/src/channels/channel-turn-dispatcher.js";
import { CommandRouter } from "../../../packages/brewva-gateway/src/channels/command-router.js";
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

function createTurnWalStoreStub(): TurnWALStore {
  return {
    appendPending: () => ({ walId: "wal-1" }),
    markInflight: () => undefined,
    markDone: () => undefined,
    markFailed: () => undefined,
  } as unknown as TurnWALStore;
}

describe("channel turn dispatcher ingress routing", () => {
  test("given a user mention that targets an active agent, when resolveIngestedSessionId runs, then the dispatcher returns the live session for the mentioned agent", () => {
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      turnWalStore: createTurnWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      isAgentActive: (agentId) => agentId === "reviewer",
      resolveLiveSessionId: (_scopeKey, agentId) =>
        agentId === "reviewer" ? "agent-session:reviewer" : undefined,
      resolveApprovalTargetAgentId: () => undefined,
      processUserTurnOnAgent: async () => undefined,
      handleCommand: async () => ({ handled: false }),
      prepareCommand: async (match) => ({ match, handled: false }),
      isShuttingDown: () => false,
    });

    const sessionId = dispatcher.resolveIngestedSessionId(
      createUserTurn("@reviewer run the release checklist"),
    );

    expect(sessionId).toBe("agent-session:reviewer");
  });

  test("given an approval turn with a resolved approval target, when resolveIngestedSessionId runs, then the dispatcher prefers the approval target session", () => {
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      turnWalStore: createTurnWalStoreStub(),
      orchestrationEnabled: true,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: () => "telegram:12345",
      resolveFocusedAgentId: () => "default",
      isAgentActive: () => true,
      resolveLiveSessionId: (_scopeKey, agentId) =>
        agentId === "approver" ? "agent-session:approver" : "agent-session:default",
      resolveApprovalTargetAgentId: () => "approver",
      processUserTurnOnAgent: async () => undefined,
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

    const sessionId = dispatcher.resolveIngestedSessionId(approvalTurn);

    expect(sessionId).toBe("agent-session:approver");
  });

  test("given many scopes, when last-turn cache exceeds capacity, then least recently used scopes are evicted", async () => {
    const dispatcher = createChannelTurnDispatcher({
      runtime: createRuntimeFixture(),
      turnWalStore: createTurnWalStoreStub(),
      orchestrationEnabled: false,
      defaultAgentId: "default",
      commandRouter: new CommandRouter(),
      replyWriter: {
        sendControllerReply: async () => undefined,
        sendAgentOutputs: async () => 0,
      },
      resolveScopeKey: (turn) => turn.conversationId,
      resolveFocusedAgentId: () => "default",
      isAgentActive: () => true,
      resolveLiveSessionId: () => "agent-session:default",
      resolveApprovalTargetAgentId: () => undefined,
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
});
