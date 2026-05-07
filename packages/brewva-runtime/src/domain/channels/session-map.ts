import { shortSha256Hex } from "@brewva/brewva-std/hash";
import { normalizeChannelId } from "./channel-id.js";

const SESSION_ID_PREFIX = "channel:";
const SESSION_HASH_LENGTH = 40;

function normalizeToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function buildRawConversationKey(channel: string, conversationId: string): string {
  const normalizedChannel = normalizeChannelId(normalizeToken(channel, "channel"));
  if (!normalizedChannel) {
    throw new Error("channel is required");
  }
  const normalizedConversationId = normalizeToken(conversationId, "conversationId");
  return `${normalizedChannel}:${normalizedConversationId}`;
}

export function buildChannelSessionId(channel: string, conversationId: string): string {
  const rawKey = buildRawConversationKey(channel, conversationId);
  return `${SESSION_ID_PREFIX}${shortSha256Hex(rawKey, SESSION_HASH_LENGTH)}`;
}

export function buildChannelDedupeKey(
  channel: string,
  conversationId: string,
  messageId: string,
): string {
  const normalizedMessageId = normalizeToken(messageId, "messageId");
  return `${buildRawConversationKey(channel, conversationId)}:${normalizedMessageId}`;
}
