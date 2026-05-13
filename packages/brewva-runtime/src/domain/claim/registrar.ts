import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import { ClaimService } from "./claim.js";

export interface RuntimeClaimDomainRegistration {
  services: {
    claimService: ClaimService;
  };
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
  };
}
