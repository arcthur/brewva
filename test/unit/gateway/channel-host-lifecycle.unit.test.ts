import { describe, expect, test } from "bun:test";
import {
  ChannelTurnBridge,
  type ChannelAdapter,
  type TurnWALStore,
} from "@brewva/brewva-runtime/channels";
import { runChannelHostLifecycle } from "../../../packages/brewva-gateway/src/channels/channel-host-lifecycle.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

function createTurnWalStoreStub(callOrder: string[]): TurnWALStore {
  return {
    isEnabled: false,
    scope: "test:channel-turn-wal",
    compact() {
      callOrder.push("turnWal.compact");
    },
  } as unknown as TurnWALStore;
}

describe("channel host lifecycle", () => {
  test("orchestrates bridge shutdown and queue disposal through the lifecycle boundary", async () => {
    const callOrder: string[] = [];
    const abortController = new AbortController();
    const runtime = createRuntimeFixture();
    const bridge = new ChannelTurnBridge(
      {
        id: "test-adapter",
        capabilities: () => ({
          streaming: false,
          inlineActions: false,
          codeBlocks: true,
          multiModal: false,
          threadedReplies: false,
        }),
        start: async () => {
          callOrder.push("bridge.start");
        },
        stop: async () => {
          callOrder.push("bridge.stop");
        },
        sendTurn: async () => ({}),
      } satisfies ChannelAdapter,
      {
        onInboundTurn: async () => {
          callOrder.push("bridge.onInboundTurn");
        },
      },
    );

    await runChannelHostLifecycle({
      runtime,
      channel: "telegram",
      verbose: false,
      bundle: {
        bridge,
        onStart: async () => {
          callOrder.push("onStart");
          queueMicrotask(() => abortController.abort());
        },
        onStop: async () => {
          callOrder.push("onStop");
        },
      },
      turnWalStore: createTurnWalStoreStub(callOrder),
      turnWalCompactIntervalMs: 30_000,
      dispatcher: {
        enqueueInboundTurn: async () => {
          callOrder.push("dispatcher.enqueueInboundTurn");
        },
        listQueueTails: () => {
          callOrder.push("dispatcher.listQueueTails");
          return [Promise.resolve()];
        },
      },
      sessionCoordinator: {
        listQueueTails: () => {
          callOrder.push("session.listQueueTails");
          return [Promise.resolve()];
        },
        disposeAllSessions: async () => {
          callOrder.push("session.disposeAllSessions");
        },
        evictIdleAgentRuntimesByTtl: async () => {
          callOrder.push("session.evictIdleAgentRuntimesByTtl");
          return [];
        },
      },
      runtimeManager: {
        disposeAll: () => {
          callOrder.push("runtime.disposeAll");
        },
        evictIdleRuntimes: () => {
          callOrder.push("runtime.evictIdleRuntimes");
          return [];
        },
      },
      shutdownSignal: abortController.signal,
      setShuttingDown: (value) => {
        callOrder.push(`setShuttingDown:${String(value)}`);
      },
    });

    expect(callOrder).toContain("turnWal.compact");
    expect(callOrder).toEqual(
      expect.arrayContaining([
        "bridge.start",
        "onStart",
        "setShuttingDown:true",
        "onStop",
        "bridge.stop",
        "dispatcher.listQueueTails",
        "session.listQueueTails",
        "session.disposeAllSessions",
        "runtime.disposeAll",
      ]),
    );
    expect(callOrder).not.toContain("dispatcher.enqueueInboundTurn");
    expect(callOrder).not.toContain("bridge.onInboundTurn");
    expect(callOrder.indexOf("onStop")).toBeLessThan(callOrder.indexOf("bridge.stop"));
    expect(callOrder.indexOf("dispatcher.listQueueTails")).toBeLessThan(
      callOrder.indexOf("session.disposeAllSessions"),
    );
    expect(callOrder.indexOf("session.listQueueTails")).toBeLessThan(
      callOrder.indexOf("session.disposeAllSessions"),
    );
  });
});
