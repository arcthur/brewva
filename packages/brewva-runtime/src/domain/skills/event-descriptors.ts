import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import { SKILL_REFRESH_RECORDED_EVENT_TYPE } from "./events.js";

export const SKILLS_EVENT_DESCRIPTORS = [] as const;

export const SKILLS_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: SKILL_REFRESH_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
] as const;
