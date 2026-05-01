import { defineBrewvaUntypedEventDefinition } from "./definition-core.js";
import {
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
} from "./observability-events.js";

export const OBSERVABILITY_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
] as const;
