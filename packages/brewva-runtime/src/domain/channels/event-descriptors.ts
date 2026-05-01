import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  CHANNEL_SESSION_BOUND_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  GATEWAY_SESSION_BOUND_EVENT_TYPE,
} from "./events.js";

export const CHANNEL_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CHANNEL_SESSION_BOUND_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GATEWAY_SESSION_BOUND_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
] as const;
