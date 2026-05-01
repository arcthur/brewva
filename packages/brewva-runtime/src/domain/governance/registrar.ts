import type {
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
} from "../../runtime/service-registrar-types.js";
import { ReversibleMutationService } from "./reversible-mutation.js";

export interface RuntimeGovernanceDomainRegistration {
  services: Pick<RuntimeGovernanceServices, "reversibleMutationService">;
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
