import { describe, expect, test } from "bun:test";
import { createRuntimeChannelTurnBridge } from "@brewva/brewva-gateway/channels";
import { createHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  DEFAULT_CHANNEL_CAPABILITIES,
  type ChannelAdapter,
  type TurnEnvelope,
} from "@brewva/brewva-runtime/channels";
import { assertRejectsWithMessage } from "../../../helpers.js";
import { createRuntimeFixture } from "../../../helpers/runtime.js";

type CapturedRuntimeEvent = {
  type?: string;
  payload?: Record<string, unknown>;
  sessionId?: string;
  turn?: number;
  timestamp?: number;
};

const BASE_TURN: TurnEnvelope = {
  schema: "brewva.turn.v1",
  kind: "assistant",
  sessionId: "channel:session",
  turnId: "turn-1",
  channel: "telegram",
  conversationId: "123",
  timestamp: 1_700_000_000_000,
  parts: [{ type: "text", text: "hello" }],
};

function createAdapter(options?: { sendError?: Error }): {
  adapter: ChannelAdapter;
  emitInbound: (turn: TurnEnvelope) => Promise<void>;
} {
  let onTurn: ((turn: TurnEnvelope) => Promise<void>) | null = null;
  const adapter: ChannelAdapter = {
    id: "telegram",
    capabilities: () => DEFAULT_CHANNEL_CAPABILITIES,
    start: async (params) => {
      onTurn = params.onTurn;
    },
    stop: async () => undefined,
    sendTurn: async () => {
      if (options?.sendError) {
        throw options.sendError;
      }
      return { providerMessageId: "tg:100" };
    },
  };

  return {
    adapter,
    emitInbound: async (turn) => {
      if (!onTurn) {
        throw new Error("adapter not started");
      }
      await onTurn(turn);
    },
  };
}

describe("channel turn bridge hosted behavior helper", () => {
  test("given bridge activity, when hosted behavior helper runs, then ingested and emitted events are recorded with channel metadata", async () => {
    const events: CapturedRuntimeEvent[] = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: CapturedRuntimeEvent) => {
          events.push(input);
        },
      },
    });
    const { adapter, emitInbound } = createAdapter();
    const bridge = createRuntimeChannelTurnBridge({
      runtime: createHostedRuntimePort(runtime),
      adapter,
      onInboundTurn: async () => undefined,
    });

    await bridge.start();
    await emitInbound({
      ...BASE_TURN,
      kind: "user",
      turnId: "turn-inbound",
      messageId: "10",
    });
    await bridge.sendTurn(BASE_TURN);
    await bridge.stop();

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("channel_turn_ingested");
    expect(events[1]?.type).toBe("channel_turn_emitted");
    expect(events[0]?.sessionId).toBe("channel:session");
    expect((events[0]?.payload as { messageId?: string } | undefined)?.messageId).toBe("10");
    expect(
      (events[1]?.payload as { providerMessageId?: string | null } | undefined)?.providerMessageId,
    ).toBe("tg:100");
  });

  test("given async inbound handling, when inbound turn is handled, then ingest telemetry is recorded after dispatcher handoff completes", async () => {
    const events: Array<CapturedRuntimeEvent | { marker: string }> = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: CapturedRuntimeEvent) => {
          events.push(input);
        },
      },
    });
    const { adapter, emitInbound } = createAdapter();
    const bridge = createRuntimeChannelTurnBridge({
      runtime: createHostedRuntimePort(runtime),
      adapter,
      onInboundTurn: async () => {
        events.push({ marker: "inbound-complete" });
      },
    });

    await bridge.start();
    await emitInbound({
      ...BASE_TURN,
      kind: "user",
      turnId: "turn-ordered-ingest",
    });
    await bridge.stop();

    expect(events).toEqual([
      { marker: "inbound-complete" },
      expect.objectContaining({
        type: "channel_turn_ingested",
        sessionId: "channel:session",
      }),
    ]);
  });

  test("given adapter send failure, when bridge sends turn, then bridge error event is recorded", async () => {
    const events: CapturedRuntimeEvent[] = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: CapturedRuntimeEvent) => {
          events.push(input);
        },
      },
    });
    const { adapter } = createAdapter({ sendError: new Error("send failed") });
    const bridge = createRuntimeChannelTurnBridge({
      runtime: createHostedRuntimePort(runtime),
      adapter,
      onInboundTurn: async () => undefined,
    });

    await bridge.start();
    await assertRejectsWithMessage(() => bridge.sendTurn(BASE_TURN), "send failed");
    await bridge.stop();

    expect(events.map((entry) => entry.type)).toContain("channel_turn_bridge_error");
  });

  test("given inbound turn telemetry, when bridge records ingestion, then the original channel session id is preserved", async () => {
    const events: CapturedRuntimeEvent[] = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: CapturedRuntimeEvent) => {
          events.push(input);
        },
      },
    });
    const inboundTurns: TurnEnvelope[] = [];
    const { adapter, emitInbound } = createAdapter();
    const bridge = createRuntimeChannelTurnBridge({
      runtime: createHostedRuntimePort(runtime),
      adapter,
      onInboundTurn: async (turn) => {
        inboundTurns.push(turn);
      },
    });

    await bridge.start();
    await emitInbound({
      ...BASE_TURN,
      kind: "user",
      turnId: "turn-ingest-resolved",
    });
    await bridge.stop();

    expect(inboundTurns).toHaveLength(1);
    const ingested = events.find((entry) => entry.type === "channel_turn_ingested");
    expect(ingested?.sessionId).toBe("channel:session");
    expect((ingested?.payload as Record<string, unknown>)?.turnSessionId).toBe("channel:session");
  });
});
