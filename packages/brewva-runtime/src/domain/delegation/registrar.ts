import { DELEGATION_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { delegationSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeDelegationDomainRegistration {
  surfaceContribution: typeof delegationSurfaceContribution;
  eventDescriptors: typeof DELEGATION_EVENT_DESCRIPTORS;
}

export function registerDelegationDomain(): RuntimeDelegationDomainRegistration {
  return {
    surfaceContribution: delegationSurfaceContribution,
    eventDescriptors: DELEGATION_EVENT_DESCRIPTORS,
  };
}
