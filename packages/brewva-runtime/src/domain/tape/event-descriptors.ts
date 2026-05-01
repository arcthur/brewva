import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./events.js";

export const TAPE_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: TAPE_ANCHOR_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TAPE_CHECKPOINT_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
] as const;
