import type { RuntimeServiceRegistrarOptions } from "../../runtime/wiring.js";
import type { ReversibleMutationService } from "../governance/api.js";
import { ConventionAdmissionService } from "./service.js";

export interface RuntimeConventionsDomainRegistration {
  services: {
    getConventionAdmissionService(): ConventionAdmissionService;
  };
}

export function registerConventionsDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    reversibleMutationService: ReversibleMutationService;
  },
): RuntimeConventionsDomainRegistration {
  let conventionAdmissionService: ConventionAdmissionService | undefined;
  const getConventionAdmissionService = (): ConventionAdmissionService => {
    conventionAdmissionService ??= new ConventionAdmissionService({
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      reversibleMutationService: support.reversibleMutationService,
    });
    return conventionAdmissionService;
  };
  return {
    services: {
      getConventionAdmissionService,
    },
  };
}
