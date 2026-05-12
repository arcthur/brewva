import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { CLAIM_EVENT_TYPE } from "./events.js";

export const CLAIM_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: CLAIM_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
] as const;
