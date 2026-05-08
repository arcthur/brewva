import { defineBrewvaUntypedEventDefinition } from "./definition-core.js";
import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
} from "./knowledge-events.js";

export const KNOWLEDGE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: RECALL_CURATION_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECALL_UTILITY_OBSERVED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
] as const;
