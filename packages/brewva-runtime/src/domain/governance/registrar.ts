import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import { ReversibleMutationService } from "./reversible-mutation.js";

export interface RuntimeGovernanceDomainRegistration {
  services: {
    reversibleMutationService: ReversibleMutationService;
  };
}

export function registerGovernanceDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeGovernanceDomainRegistration {
  return {
    services: {
      reversibleMutationService: new ReversibleMutationService({
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        recordEvent: (input) => options.kernel.recordEvent(input),
        resolveToolAuthority: (toolName) => options.resolveToolAuthority(toolName),
      }),
    },
  };
}
