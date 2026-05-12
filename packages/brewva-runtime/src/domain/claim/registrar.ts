import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { ClaimService } from "./claim.js";
import { claimSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeClaimDomainRegistration {
  services: {
    claimService: ClaimService;
  };
  surfaceContribution: typeof claimSurfaceContribution;
}

export function registerClaimDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeClaimDomainRegistration {
  return {
    services: {
      claimService: new ClaimService({
        getClaimState: (sessionId) => options.kernel.getClaimState(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
      }),
    },
    surfaceContribution: claimSurfaceContribution,
  };
}
