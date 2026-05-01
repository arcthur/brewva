import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
  SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
  SCHEDULE_TRIGGER_APPLY_WARNING_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
} from "./events.js";

export const SCHEDULE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_RECOVERY_DEFERRED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_RECOVERY_SUMMARY_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_TRIGGER_APPLY_WARNING_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SCHEDULE_WAKEUP_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
] as const;
