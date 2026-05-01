import { defineBrewvaUntypedEventDefinition } from "./definition-core.js";
import {
  EVENT_LISTENER_ERROR_EVENT_TYPE,
  EXEC_FAILED_EVENT_TYPE,
  EXEC_STARTED_EVENT_TYPE,
} from "./exec-events.js";

export const EXEC_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: EVENT_LISTENER_ERROR_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: EXEC_FAILED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: EXEC_STARTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
] as const;
