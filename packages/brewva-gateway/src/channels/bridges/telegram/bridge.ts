import {
  TelegramChannelAdapter,
  TelegramHttpTransport,
  type TelegramChannelAdapterOptions,
  type TelegramChannelTransport,
  type TelegramHttpTransportOptions,
} from "@brewva/brewva-channels-telegram";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { createRuntimeChannelTurnBridge } from "./turn-bridge.js";

export interface CreateRuntimeTelegramChannelBridgeOptions {
  runtime: BrewvaHostedRuntimePort;
  token?: string;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
  adapter?: Omit<TelegramChannelAdapterOptions, "transport">;
  transport?: Omit<TelegramHttpTransportOptions, "token">;
  transportInstance?: TelegramChannelTransport;
}

export interface RuntimeTelegramChannelBridge {
  bridge: ChannelTurnBridge;
  adapter: TelegramChannelAdapter;
  transport: TelegramChannelTransport;
}

export function createRuntimeTelegramChannelBridge(
  options: CreateRuntimeTelegramChannelBridgeOptions,
): RuntimeTelegramChannelBridge {
  const transport =
    options.transportInstance ??
    (() => {
      const token = options.token?.trim() ?? "";
      if (!token) {
        throw new Error("telegram token is required when transportInstance is not provided");
      }
      return new TelegramHttpTransport({
        token,
        ...options.transport,
      });
    })();
  const adapter = new TelegramChannelAdapter({
    ...options.adapter,
    transport,
  });
  const bridge = createRuntimeChannelTurnBridge({
    runtime: options.runtime,
    adapter,
    onInboundTurn: options.onInboundTurn,
    onAdapterError: options.onAdapterError,
  });
  return { bridge, adapter, transport };
}
