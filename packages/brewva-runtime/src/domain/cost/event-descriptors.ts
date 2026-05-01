import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { BUDGET_ALERT_EVENT_TYPE, COST_UPDATE_EVENT_TYPE } from "./events.js";

export const COST_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: BUDGET_ALERT_EVENT_TYPE,
    category: "cost",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: COST_UPDATE_EVENT_TYPE,
    category: "cost",
    durability: "source_of_truth",
  }),
] as const;
