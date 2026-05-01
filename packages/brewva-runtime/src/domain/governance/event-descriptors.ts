import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
  GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE,
  GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE,
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
  TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
} from "./events.js";

export const GOVERNANCE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_COMPACTION_INTEGRITY_CHECKED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_COMPACTION_INTEGRITY_ERROR_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_COMPACTION_INTEGRITY_FAILED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_COST_ANOMALY_DETECTED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_COST_ANOMALY_ERROR_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
    category: "governance",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_VERIFY_SPEC_ERROR_EVENT_TYPE,
    category: "governance",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
    category: "governance",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
    category: "governance",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: STEER_APPLIED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: STEER_DROPPED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: STEER_QUEUED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
] as const;
