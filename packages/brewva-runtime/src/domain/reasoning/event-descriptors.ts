import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import { REASONING_CHECKPOINT_EVENT_TYPE, REASONING_REVERT_EVENT_TYPE } from "./events.js";
import { coerceReasoningRevertPayload, type ReasoningRevertPayload } from "./payloads.js";

export const REASONING_REVERT_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: REASONING_REVERT_EVENT_TYPE,
  category: "state",
  durability: "source_of_truth",
  readPayload(payload): ReasoningRevertPayload | null {
    return coerceReasoningRevertPayload(payload);
  },
});

export const REASONING_EVENT_DESCRIPTORS = [REASONING_REVERT_EVENT_DESCRIPTOR] as const;

export const REASONING_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: REASONING_CHECKPOINT_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
] as const;

export function readReasoningRevertEventPayload(
  event: BrewvaEventLike,
): ReasoningRevertPayload | null {
  return readBrewvaEventPayload(event, REASONING_REVERT_EVENT_DESCRIPTOR);
}
