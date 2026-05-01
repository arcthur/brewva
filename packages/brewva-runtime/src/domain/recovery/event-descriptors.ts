import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  CRITICAL_WITHOUT_COMPACT_EVENT_TYPE,
  RECOVERY_WAL_APPENDED_EVENT_TYPE,
  RECOVERY_WAL_COMPACTED_EVENT_TYPE,
  RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
  RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE,
} from "./events.js";

export const RECOVERY_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: CRITICAL_WITHOUT_COMPACT_EVENT_TYPE,
    category: "other",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECOVERY_WAL_APPENDED_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECOVERY_WAL_COMPACTED_EVENT_TYPE,
    category: "other",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECOVERY_WAL_RECOVERY_COMPLETED_EVENT_TYPE,
    category: "other",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: RECOVERY_WAL_STATUS_CHANGED_EVENT_TYPE,
    category: "other",
    durability: "rebuildable_signal",
  }),
] as const;
