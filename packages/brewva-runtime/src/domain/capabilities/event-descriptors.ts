import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { CAPABILITY_SELECTION_RECORDED_EVENT_TYPE } from "./events.js";

export const CAPABILITIES_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: CAPABILITY_SELECTION_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
] as const;
