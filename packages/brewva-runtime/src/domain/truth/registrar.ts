import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { truthSurfaceContribution } from "./runtime-surface.js";
import { TruthService } from "./truth.js";

export interface RuntimeTruthDomainRegistration {
  services: {
    truthService: TruthService;
  };
  surfaceContribution: typeof truthSurfaceContribution;
}

export function registerTruthDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeTruthDomainRegistration {
  return {
    services: {
      truthService: new TruthService({
        getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
      }),
    },
    surfaceContribution: truthSurfaceContribution,
  };
}
