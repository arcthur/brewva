import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  COMPACTION_INTEGRITY_VIOLATION_EVENT_TYPE,
  CONTEXT_ARENA_SLO_ENFORCED_EVENT_TYPE,
  CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
  CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
  CONTEXT_COMPACTION_REQUESTED_EVENT_TYPE,
  CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
  CONTEXT_COMPOSED_EVENT_TYPE,
  CONTEXT_INJECTED_EVENT_TYPE,
  CONTEXT_INJECTION_DROPPED_EVENT_TYPE,
  CONTEXT_USAGE_EVENT_TYPE,
  IDENTITY_PARSE_WARNING_EVENT_TYPE,
} from "./events.js";

export const CONTEXT_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: COMPACTION_INTEGRITY_VIOLATION_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_ARENA_SLO_ENFORCED_EVENT_TYPE,
    category: "context",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_ADVISORY_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_AUTO_COMPLETED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_AUTO_FAILED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_AUTO_REQUESTED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_GATE_ARMED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
    category: "tool",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_GATE_CLEARED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_REQUESTED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPACTION_SKIPPED_EVENT_TYPE,
    category: "context",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_COMPOSED_EVENT_TYPE,
    category: "context",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_INJECTED_EVENT_TYPE,
    category: "context",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_INJECTION_DROPPED_EVENT_TYPE,
    category: "context",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: CONTEXT_USAGE_EVENT_TYPE,
    category: "context",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: IDENTITY_PARSE_WARNING_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
] as const;
