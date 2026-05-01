import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  PATCH_RECORDED_EVENT_TYPE,
  REDO_EVENT_TYPE,
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_REDONE_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
  ROLLBACK_EVENT_TYPE,
} from "./events.js";

export const PATCHING_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
    category: "state",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: PATCH_RECORDED_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: REDO_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: REVERSIBLE_MUTATION_REDONE_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
    category: "other",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: ROLLBACK_EVENT_TYPE,
    category: "tool",
    durability: "source_of_truth",
  }),
] as const;
