import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import { SKILLS_EVENT_DESCRIPTORS } from "./event-descriptors.js";

export interface RuntimeSkillsDomainRegistration {
  services: Record<string, never>;
  eventDescriptors: typeof SKILLS_EVENT_DESCRIPTORS;
}

export function registerSkillsDomain(
  _options: RuntimeServiceRegistrarOptions,
): RuntimeSkillsDomainRegistration {
  return {
    services: {},
    eventDescriptors: SKILLS_EVENT_DESCRIPTORS,
  };
}
