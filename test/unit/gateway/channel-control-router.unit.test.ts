import { describe, expect, test } from "bun:test";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createChannelControlRouter } from "../../../packages/brewva-gateway/src/channels/channel-control-router.js";
import { createChannelUpdateLockManager } from "../../../packages/brewva-gateway/src/channels/channel-update-lock.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

function createUserTurn(text: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "channel-session:telegram",
    turnId: "turn-1",
    channel: "telegram",
    conversationId: "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text }],
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
});
