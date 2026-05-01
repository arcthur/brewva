import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  PARALLEL_SLOT_REJECTED_EVENT_TYPE,
  RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
  RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
  RESOURCE_LEASE_GRANTED_EVENT_TYPE,
} from "./events.js";

export const PARALLEL_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: PARALLEL_SLOT_REJECTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RESOURCE_LEASE_CANCELLED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RESOURCE_LEASE_EXPIRED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RESOURCE_LEASE_GRANTED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
] as const;
