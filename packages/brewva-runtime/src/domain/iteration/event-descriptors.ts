import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
} from "./events.js";

export const ITERATION_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: ITERATION_GUARD_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
] as const;
