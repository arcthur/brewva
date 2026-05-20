import type { TurnEnvelope } from "@brewva/brewva-runtime/protocol";

export const DEFAULT_TELEGRAM_CHANNEL_NAME = "telegram";

export interface TelegramChannelPolicyState {
  channelName: string;
}

function normalizeChannelName(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveTelegramChannelPolicyState(
  input: {
    channelName?: string;
  } = {},
): TelegramChannelPolicyState {
  return {
    channelName: normalizeChannelName(input.channelName, DEFAULT_TELEGRAM_CHANNEL_NAME),
  };
}

export function buildChannelPolicyBlock(
  turn: TurnEnvelope,
  state: TelegramChannelPolicyState = resolveTelegramChannelPolicyState(),
): string {
  if (turn.channel !== "telegram") {
    return "";
  }

  return [
    "[Brewva Channel Policy]",
    "Channel: telegram",
    `Transport: ${state.channelName}`,
    "Use the ordinary model-operated tool surface; do not load a channel skill before responding.",
    "Choose response shape from the current turn, available tools, and channel affordances.",
  ].join("\n");
}
