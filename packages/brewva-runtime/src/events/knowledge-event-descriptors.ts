import { defineBrewvaUntypedEventDefinition } from "./definition-core.js";
import {
  NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
  NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
  NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
  NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
  NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  RECALL_UTILITY_OBSERVED_EVENT_TYPE,
  SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
  SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
} from "./knowledge-events.js";

export const KNOWLEDGE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: NARRATIVE_MEMORY_ARCHIVED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: NARRATIVE_MEMORY_FORGOTTEN_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: NARRATIVE_MEMORY_PROMOTED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: NARRATIVE_MEMORY_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: NARRATIVE_MEMORY_REVIEWED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
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
  defineBrewvaUntypedEventDefinition({
    type: SEMANTIC_EXTRACTION_INVOKED_EVENT_TYPE,
    category: "control",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SEMANTIC_RERANK_INVOKED_EVENT_TYPE,
    category: "control",
    durability: "rebuildable_signal",
  }),
] as const;
