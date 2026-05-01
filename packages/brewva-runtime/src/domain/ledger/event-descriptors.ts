import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { LEDGER_COMPACTED_EVENT_TYPE } from "./events.js";

export const LEDGER_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: LEDGER_COMPACTED_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
] as const;
