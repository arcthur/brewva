import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  AGENT_END_EVENT_TYPE,
  MESSAGE_END_EVENT_TYPE,
  MODEL_PRESET_SELECT_EVENT_TYPE,
  MODEL_SELECT_EVENT_TYPE,
  SESSION_BEFORE_COMPACT_EVENT_TYPE,
  SESSION_BOOTSTRAP_EVENT_TYPE,
  SESSION_COMPACT_EVENT_TYPE,
  SESSION_COMPACT_FAILED_EVENT_TYPE,
  SESSION_COMPACT_REQUESTED_EVENT_TYPE,
  SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
  SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE,
  SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_SUPERSEDED_EVENT_TYPE,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_START_EVENT_TYPE,
  TURN_END_EVENT_TYPE,
  TURN_START_EVENT_TYPE,
} from "./events.js";

export const LIFECYCLE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: AGENT_END_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: MESSAGE_END_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: MODEL_PRESET_SELECT_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: MODEL_SELECT_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_BEFORE_COMPACT_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_BOOTSTRAP_EVENT_TYPE,
    category: "session",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_COMPACT_EVENT_TYPE,
    category: "session",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_COMPACT_FAILED_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_COMPACT_REQUESTED_EVENT_TYPE,
    category: "session",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
    category: "session",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_REWIND_SUPERSEDED_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_SHUTDOWN_EVENT_TYPE,
    category: "session",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SESSION_START_EVENT_TYPE,
    category: "session",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TURN_END_EVENT_TYPE,
    category: "turn",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TURN_START_EVENT_TYPE,
    category: "turn",
    durability: "source_of_truth",
  }),
] as const;
