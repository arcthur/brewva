import { describe, expect, test } from "bun:test";
import type {
  AdapterStartContext,
  ChannelAdapter,
  AdapterSendResult,
  TurnEnvelope,
} from "@brewva/brewva-runtime/channels";
import { ChannelTurnBridge } from "@brewva/brewva-runtime/channels";

const BASE_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "t-1",
  channel: "telegram",
  conversationId: "123",
  threadId: "thread-42",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello" }],
};

function createAdapter(options: { streaming?: boolean } = {}): {
  adapter: ChannelAdapter;
  sentTurns: TurnEnvelope[];
  streamedTurns: TurnEnvelope[];
  streamedChunks: string[];
  startCalls: number;
  stopCalls: number;
  emitInbound: (turn: TurnEnvelope) => Promise<void>;
} {
  let startContext: AdapterStartContext | null = null;
  const sentTurns: TurnEnvelope[] = [];
  const streamedTurns: TurnEnvelope[] = [];
  const streamedChunks: string[] = [];
  let startCalls = 0;
  let stopCalls = 0;
  const adapter: ChannelAdapter = {
    id: "telegram",
    capabilities: () => ({
      streaming: options.streaming ?? false,
      inlineActions: false,
      codeBlocks: true,
      multiModal: true,
      threadedReplies: false,
    }),
    start: async (ctx) => {
      startCalls += 1;
      startContext = ctx;
    },
    stop: async () => {
      stopCalls += 1;
    },
    sendTurn: async (turn) => {
      sentTurns.push(turn);
      return { providerMessageId: "out-1" };
    },
    sendTurnStream: async (turn, stream) => {
      streamedTurns.push(turn);
      stream.write("chunk-1");
      stream.write("chunk-2");
      streamedChunks.push("chunk-1", "chunk-2");
      return { providerMessageId: "stream-1" };
    },
  };

  return {
    adapter,
    sentTurns,
    streamedTurns,
    streamedChunks,
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    emitInbound: async (turn) => {
      if (!startContext) {
        throw new Error("adapter not started");
      }
      await startContext.onTurn(turn);
    },
  };
}

describe("channel turn bridge", () => {
  test("given adapter inbound callback, when bridge receives turn, then turn is forwarded and ingestion hook is invoked", async () => {
    const inbound: TurnEnvelope[] = [];
    const ingested: TurnEnvelope[] = [];
    const { adapter, emitInbound } = createAdapter();
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async (turn) => {
        inbound.push(turn);
      },
      onTurnIngested: async (turn) => {
        ingested.push(turn);
      },
    });

    await bridge.start();
    await emitInbound(BASE_TURN);
    expect(inbound).toEqual([BASE_TURN]);
    expect(ingested).toEqual([BASE_TURN]);
    await bridge.stop();
  });

  test("given inbound handler failure, when the adapter emits a turn, then the error is surfaced to the caller", async () => {
    const { adapter, emitInbound } = createAdapter();
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => {
        throw new Error("inbound failed");
      },
    });

    await bridge.start();
    try {
      await emitInbound(BASE_TURN);
      throw new Error("expected inbound turn to fail");
    } catch (error) {
      expect((error as Error).message).toBe("inbound failed");
    } finally {
      await bridge.stop();
    }
  });

  test("given channel lacks thread replies, when bridge sends outbound turn, then thread context is normalized before delivery", async () => {
    const { adapter, sentTurns } = createAdapter();
    const emitted: Array<{ requestedTurn: TurnEnvelope; deliveredTurn: TurnEnvelope }> = [];
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => undefined,
      onTurnEmitted: async (input) => {
        emitted.push({
          requestedTurn: input.requestedTurn,
          deliveredTurn: input.deliveredTurn,
        });
      },
    });

    await bridge.start();
    await bridge.sendTurn(BASE_TURN);
    await bridge.stop();

    expect(sentTurns).toHaveLength(1);
    const sent = sentTurns[0];
    if (!sent) {
      throw new Error("expected sent turn");
    }
    expect(sent.parts[0]).toEqual({
      type: "text",
      text: "[thread:thread-42]\nhello",
    });
    const deliveryPlan = sent.meta?.deliveryPlan as { threadMode?: string } | undefined;
    expect(deliveryPlan?.threadMode).toBe("prepend_context");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.requestedTurn.turnId).toBe(BASE_TURN.turnId);
    expect(emitted[0]?.deliveredTurn.turnId).toBe(BASE_TURN.turnId);
  });

  test("given repeated start and stop, when bridge lifecycle is toggled, then adapter start and stop remain idempotent", async () => {
    const harness = createAdapter();
    const bridge = new ChannelTurnBridge(harness.adapter, {
      onInboundTurn: async () => undefined,
    });

    await bridge.start();
    await bridge.start();
    expect(bridge.isRunning()).toBe(true);

    await bridge.stop();
    await bridge.stop();

    expect(harness.startCalls).toBe(1);
    expect(harness.stopCalls).toBe(1);
    expect(bridge.isRunning()).toBe(false);
  });

  test("given adapter start failure, when bridge start rejects, then the bridge stays stopped", async () => {
    const adapter: ChannelAdapter = {
      id: "telegram",
      capabilities: () => ({
        streaming: false,
        inlineActions: false,
        codeBlocks: true,
        multiModal: true,
        threadedReplies: false,
      }),
      start: async () => {
        throw new Error("start failed");
      },
      stop: async () => undefined,
      sendTurn: async () => ({ providerMessageId: "out-1" }),
    };
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => undefined,
    });

    try {
      await bridge.start();
      throw new Error("expected start to fail");
    } catch (error) {
      expect((error as Error).message).toBe("start failed");
      expect(bridge.isRunning()).toBe(false);
    }
  });

  test("given a streaming channel, when the bridge sends a turn, then stream chunks are surfaced to the handler", async () => {
    const { adapter, streamedTurns, streamedChunks } = createAdapter({ streaming: true });
    const observedChunks: string[] = [];
    const emitted: Array<{ providerMessageId?: string | null }> = [];
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => undefined,
      onStreamChunk: (_turn, chunk) => {
        observedChunks.push(chunk);
      },
      onTurnEmitted: async (input) => {
        emitted.push({ providerMessageId: input.result.providerMessageId ?? null });
      },
    });

    const result: AdapterSendResult = await (async () => {
      await bridge.start();
      try {
        return await bridge.sendTurn(BASE_TURN);
      } finally {
        await bridge.stop();
      }
    })();

    expect(result.providerMessageId).toBe("stream-1");
    expect(streamedTurns).toHaveLength(1);
    expect(streamedChunks).toEqual(["chunk-1", "chunk-2"]);
    expect(observedChunks).toEqual(["chunk-1", "chunk-2"]);
    expect(emitted).toEqual([{ providerMessageId: "stream-1" }]);
  });

  test("given adapter send failure, when the bridge sends a turn, then adapter errors are surfaced before rethrow", async () => {
    const failure = new Error("send failed");
    const adapter: ChannelAdapter = {
      id: "telegram",
      capabilities: () => ({
        streaming: false,
        inlineActions: false,
        codeBlocks: true,
        multiModal: true,
        threadedReplies: false,
      }),
      start: async () => undefined,
      stop: async () => undefined,
      sendTurn: async () => {
        throw failure;
      },
    };
    const observedErrors: unknown[] = [];
    const bridge = new ChannelTurnBridge(adapter, {
      onInboundTurn: async () => undefined,
      onAdapterError: async (error) => {
        observedErrors.push(error);
      },
    });

    await bridge.start();
    try {
      await bridge.sendTurn(BASE_TURN);
      throw new Error("expected sendTurn to throw");
    } catch (error) {
      expect(error).toBe(failure);
      expect((error as Error).message).toBe("send failed");
    } finally {
      await bridge.stop();
    }

    expect(observedErrors).toEqual([failure]);
  });
});
