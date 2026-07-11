import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type {
  ChannelAdapter,
  ChannelTurnBridge,
  TurnEnvelope,
} from "@brewva/brewva-vocabulary/wire";
import { ChannelTurnBridge as RuntimeChannelTurnBridge } from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../../../hosted/api.js";

export interface CreateRuntimeChannelTurnBridgeOptions {
  runtime: HostedRuntimeAdapterPort;
  adapter: ChannelAdapter;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
}

function summarizeTurn(turn: TurnEnvelope): Record<string, unknown> {
  return {
    turnId: turn.turnId,
    kind: turn.kind,
    channel: turn.channel,
    conversationId: turn.conversationId,
    messageId: turn.messageId ?? null,
    threadId: turn.threadId ?? null,
    partTypes: turn.parts.map((part) => part.type),
    partCount: turn.parts.length,
    timestamp: turn.timestamp,
  };
}

export function createRuntimeChannelTurnBridge(
  options: CreateRuntimeChannelTurnBridgeOptions,
): ChannelTurnBridge {
  return new RuntimeChannelTurnBridge(options.adapter, {
    onInboundTurn: async (turn) => {
      await options.onInboundTurn(turn);
      options.runtime.ops.channel.turn.ingested({
        sessionId: turn.sessionId,
        payload: {
          adapterId: options.adapter.id,
          turnSessionId: turn.sessionId,
          ...summarizeTurn(turn),
        },
      });
    },
    onAdapterError: async (error) => {
      options.runtime.ops.channel.turn.bridgeError({
        sessionId: "channel:system",
        payload: {
          adapterId: options.adapter.id,
          error: toErrorMessage(error),
        },
      });
      await options.onAdapterError?.(error);
    },
    onTurnEmitted: async (input) => {
      options.runtime.ops.channel.turn.emitted({
        sessionId: input.deliveredTurn.sessionId,
        payload: {
          adapterId: options.adapter.id,
          ...summarizeTurn(input.deliveredTurn),
          requestedTurnId: input.requestedTurn.turnId,
          providerMessageId: input.result.providerMessageId ?? null,
        },
      });
    },
  });
}
