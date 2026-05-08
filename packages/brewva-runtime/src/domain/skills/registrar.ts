import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { SKILLS_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { skillsSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeSkillsDomainRegistration {
  services: Record<string, never>;
  surfaceContribution: typeof skillsSurfaceContribution;
  eventDescriptors: typeof SKILLS_EVENT_DESCRIPTORS;
}

export function registerSkillsDomain(
  _options: RuntimeServiceRegistrarOptions,
): RuntimeSkillsDomainRegistration {
  return {
    services: {},
    surfaceContribution: skillsSurfaceContribution,
    eventDescriptors: SKILLS_EVENT_DESCRIPTORS,
  };
}
