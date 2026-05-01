import { lifecycleSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeLifecycleDomainRegistration {
  surfaceContribution: typeof lifecycleSurfaceContribution;
}

export function registerLifecycleDomain(): RuntimeLifecycleDomainRegistration {
  return {
    surfaceContribution: lifecycleSurfaceContribution,
  };
}
