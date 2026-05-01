import { eventsSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeEventsDomainRegistration {
  surfaceContribution: typeof eventsSurfaceContribution;
}

export function registerEventsDomain(): RuntimeEventsDomainRegistration {
  return {
    surfaceContribution: eventsSurfaceContribution,
  };
}
