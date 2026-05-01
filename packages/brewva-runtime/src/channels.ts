export {
  TURN_ENVELOPE_SCHEMA,
  assertTurnEnvelope,
  buildTurnEnvelope,
  coerceTurnEnvelope,
  normalizeTurnParts,
} from "./domain/channels/api.js";
export type {
  ApprovalAction,
  ApprovalPayload,
  BuildTurnEnvelopeInput,
  TurnEnvelope,
  TurnEnvelopeCoerceResult,
  TurnKind,
  TurnPart,
} from "./domain/channels/api.js";
export { DEFAULT_CHANNEL_CAPABILITIES, resolveChannelCapabilities } from "./domain/channels/api.js";
export type { ChannelCapabilities } from "./domain/channels/api.js";
export type {
  AdapterSendResult,
  AdapterStartContext,
  ChannelAdapter,
  TurnStreamEmitter,
} from "./domain/channels/api.js";
export { normalizeChannelId } from "./domain/channels/api.js";
export {
  buildChannelDedupeKey,
  buildChannelSessionId,
  buildRawConversationKey,
} from "./domain/channels/api.js";
export { prepareTurnForDelivery, resolveTurnDeliveryPlan } from "./domain/channels/api.js";
export type { TurnDeliveryPlan } from "./domain/channels/api.js";
export { ChannelAdapterRegistry } from "./domain/channels/api.js";
export type { AdapterRegistration } from "./domain/channels/api.js";
export { ChannelTurnBridge } from "./domain/channels/api.js";
export type { TurnBridgeHandlers } from "./domain/channels/api.js";
