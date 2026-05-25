import {
  type ChannelTurnBridge,
  normalizeChannelId,
  type TurnEnvelope,
} from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import type { TelegramChannelModeConfig } from "./bridges/telegram/webhook-config.js";

export interface ChannelModeConfig {
  telegram?: TelegramChannelModeConfig;
}

export const SUPPORTED_CHANNELS = ["telegram"] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

export interface ChannelModeLaunchBundle {
  bridge: ChannelTurnBridge;
  onStart?: () => Promise<void>;
  onStop?: () => Promise<void>;
}

export interface ChannelModeLauncherInput {
  runtime: HostedRuntimeAdapterPort;
  channelConfig?: ChannelModeConfig;
  onInboundTurn: (turn: TurnEnvelope) => Promise<void>;
  onAdapterError?: (error: unknown) => Promise<void> | void;
}

export type ChannelModeLauncher = (input: ChannelModeLauncherInput) => ChannelModeLaunchBundle;

export function resolveSupportedChannel(raw: string): SupportedChannel | null {
  const normalized = normalizeChannelId(raw);
  return (SUPPORTED_CHANNELS as readonly string[]).includes(normalized)
    ? (normalized as SupportedChannel)
    : null;
}

export function formatSupportedChannels(): string {
  return SUPPORTED_CHANNELS.join(", ");
}
