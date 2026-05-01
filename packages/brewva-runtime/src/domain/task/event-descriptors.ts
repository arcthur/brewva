import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import {
  TASK_EVENT_TYPE,
  TASK_STALL_ADJUDICATED_EVENT_TYPE,
  TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
  TASK_STUCK_CLEARED_EVENT_TYPE,
  TASK_STUCK_DETECTED_EVENT_TYPE,
} from "./events.js";
import {
  coerceTaskStallAdjudicatedPayload,
  coerceTaskStuckDetectedPayload,
  type TaskStallAdjudicatedPayload,
  type TaskStuckDetectedPayload,
} from "./watchdog.js";

export { TASK_STALL_ADJUDICATED_EVENT_TYPE, TASK_STUCK_DETECTED_EVENT_TYPE } from "./events.js";

export const TASK_STUCK_DETECTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TASK_STUCK_DETECTED_EVENT_TYPE,
  category: "state",
  durability: "source_of_truth",
  readPayload(payload): TaskStuckDetectedPayload | null {
    return coerceTaskStuckDetectedPayload(payload);
  },
});

export const TASK_STALL_ADJUDICATED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: TASK_STALL_ADJUDICATED_EVENT_TYPE,
  category: "state",
  durability: "source_of_truth",
  readPayload(payload): TaskStallAdjudicatedPayload | null {
    return coerceTaskStallAdjudicatedPayload(payload);
  },
});

export const TASK_EVENT_DESCRIPTORS = [
  TASK_STUCK_DETECTED_EVENT_DESCRIPTOR,
  TASK_STALL_ADJUDICATED_EVENT_DESCRIPTOR,
] as const;

export const TASK_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE,
    category: "state",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TASK_STUCK_CLEARED_EVENT_TYPE,
    category: "state",
    durability: "durable_evidence",
  }),
] as const;

export const TASK_LEDGER_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: TASK_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
] as const;

export function readTaskStuckDetectedEventPayload(
  event: BrewvaEventLike,
): TaskStuckDetectedPayload | null {
  return readBrewvaEventPayload(event, TASK_STUCK_DETECTED_EVENT_DESCRIPTOR);
}

export function readTaskStallAdjudicatedEventPayload(
  event: BrewvaEventLike,
): TaskStallAdjudicatedPayload | null {
  return readBrewvaEventPayload(event, TASK_STALL_ADJUDICATED_EVENT_DESCRIPTOR);
}
