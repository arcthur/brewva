import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { TRUTH_EVENT_TYPE } from "./events.js";

export const TRUTH_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: TRUTH_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
] as const;
