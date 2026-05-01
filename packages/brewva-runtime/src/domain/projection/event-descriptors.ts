import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { PROJECTION_INGESTED_EVENT_TYPE, PROJECTION_REFRESHED_EVENT_TYPE } from "./events.js";

export const PROJECTION_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: PROJECTION_INGESTED_EVENT_TYPE,
    category: "state",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: PROJECTION_REFRESHED_EVENT_TYPE,
    category: "state",
    durability: "rebuildable_signal",
  }),
] as const;
