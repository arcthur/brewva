import { describe, expect, test } from "bun:test";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createChannelUpdateLockManager } from "../../../packages/brewva-gateway/src/channels/channel-update-lock.js";

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

describe("channel update lock ownership", () => {
  test("given an authorized update request is already reserved, when a second update arrives, then the manager returns a blocked reservation until the first lock is released", () => {
    const manager = createChannelUpdateLockManager({
      updateExecutionScope: {
        lockKey: "workspace-update",
        lockTarget: "workspace",
      },
    });

    const first = manager.tryReserve({
      turn: createUserTurn("/update pull latest"),
      scopeKey: "scope-1",
      agentId: "worker",
    });
    const second = manager.tryReserve({
      turn: {
        ...createUserTurn("/update rerun"),
        turnId: "turn-2",
      },
      scopeKey: "scope-2",
      agentId: "worker",
    });

    expect(first.kind).toBe("reserved");
    expect(second.kind).toBe("blocked");

    if (first.kind === "reserved") {
      first.release();
    }

    const third = manager.tryReserve({
      turn: {
        ...createUserTurn("/update final"),
        turnId: "turn-3",
      },
      scopeKey: "scope-3",
      agentId: "worker",
    });
    expect(third.kind).toBe("reserved");
  });
});
